// ============================================================================
// db.js — the receipt book. Every hot dog this treasury has ever handed out,
// who ate it, in which round, and the transaction that carries it.
//
// Three collections:
//   payouts  one document per transfer — the audit trail, never aggregated away
//   eaters   a running total per wallet, so the leaderboard is a read, not a scan
//   rounds   one document per round: how many were fed, what it cost, or why not
//
// Everything is stored in DOLLARS as well as in raw token units. The wire the
// money moved over is an implementation detail that can change — native ETH
// today, a stablecoin tomorrow — but a hot dog is a hot dog, and the counter on
// the frontend has to keep counting across that change.
//
// Degrades gracefully: with no MONGO_URL the server runs exactly as before and
// the totals simply report what this process has seen since it booted.
// ============================================================================

import { MongoClient } from 'mongodb'

export function createDb(url) {
  let client = null
  let payouts = null
  let eaters = null
  let rounds = null
  let ready = false
  let lastError = null

  async function connect() {
    if (!url) {
      console.info('[db] no MONGO_URL — running without persistence (totals reset on restart)')
      return false
    }
    try {
      client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 })
      await client.connect()
      const db = client.db()
      payouts = db.collection('payouts')
      eaters = db.collection('eaters')
      rounds = db.collection('rounds')

      // A payout is uniquely a (round, address) pair. This unique index is what
      // makes a retried or replayed round idempotent instead of feeding the
      // leaderboard twice for one transfer.
      await payouts.createIndex({ roundId: 1, to: 1 }, { unique: true })
      await payouts.createIndex({ to: 1, ts: -1 })
      await payouts.createIndex({ ts: -1 })
      await eaters.createIndex({ hotDogs: -1 })
      await rounds.createIndex({ roundId: -1 }, { unique: true })

      ready = true
      console.info('[db] connected — payouts, eaters and rounds are on the record')
      return true
    } catch (e) {
      lastError = e.message
      console.error('[db] connect failed:', e.message, '— continuing without persistence')
      return false
    }
  }

  /** Record one round's service. Writes the transfers, rolls each eater's
   *  running totals forward, and files the round itself. */
  async function recordRound({ round, items, asset, perHolderUsd, totalUsd, totalHotDogs, shortfall, buy, dryRun, demo }) {
    if (!ready) return
    const roundId = round?.id ?? Math.floor(Date.now() / 300_000)
    const ts = Date.now()
    try {
      const docs = (items || []).map((it) => ({
        roundId,
        roundLabel: round?.label ?? null,
        to: it.to,
        usd: it.usd,
        hotDogs: it.hotDogs,
        amount: it.amount,
        asset: asset?.symbol ?? null,
        heldPct: it.pct,
        tx: it.tx,
        txUrl: it.txUrl,
        dryRun: !!dryRun,
        demo: !!demo,
        ts,
      }))

      let inserted = docs
      if (docs.length) {
        try {
          await payouts.insertMany(docs, { ordered: false })
        } catch (e) {
          // ordered:false reports the duplicates it skipped; the rest did land
          const dup = new Set((e.writeErrors || []).map((w) => w.index))
          inserted = docs.filter((_, i) => !dup.has(i))
          if (!e.writeErrors) throw e
        }
      }

      if (inserted.length) {
        await eaters.bulkWrite(
          inserted.map((d) => ({
            updateOne: {
              filter: { _id: d.to },
              update: {
                $inc: { totalUsd: d.usd || 0, hotDogs: d.hotDogs || 0, meals: 1 },
                $max: { lastAt: d.ts, lastHeldPct: d.heldPct },
                $min: { firstAt: d.ts },
                $set: { lastRound: d.roundLabel },
              },
              upsert: true,
            },
          })),
          { ordered: false }
        )
      }

      await rounds.updateOne(
        { roundId },
        {
          $set: {
            roundId,
            label: round?.label ?? null,
            startedAt: round?.startedAt ?? null,
            paid: true,
            reason: null,
            served: (items || []).length,
            perHolderUsd: perHolderUsd ?? null,
            totalUsd: totalUsd ?? null,
            hotDogs: totalHotDogs ?? null,
            asset: asset?.symbol ?? null,
            shortfall: !!shortfall,
            buy: buy ?? null,
            dryRun: !!dryRun,
            demo: !!demo,
            ts,
          },
        },
        { upsert: true }
      )
      console.info(`[db] round ${round?.label ?? roundId}: ${inserted.length} receipt(s) filed`)
    } catch (e) {
      console.error('[db] recordRound:', e.message)
    }
  }

  /**
   * A round that fed nobody, and why.
   *
   * A round is a fact whether or not money moved. Recording only the successful
   * ones leaves someone looking at the history unable to tell "nobody has been
   * paid yet" apart from "the recorder is broken" — and on a page whose whole
   * claim is that it pays every five minutes, those are very different things.
   */
  async function recordSkippedRound({ round, reason }) {
    if (!ready) return
    const roundId = round?.id ?? Math.floor(Date.now() / 300_000)
    try {
      await rounds.updateOne(
        { roundId },
        {
          $set: {
            roundId,
            label: round?.label ?? null,
            startedAt: round?.startedAt ?? null,
            paid: false,
            reason,
            served: 0,
            totalUsd: 0,
            hotDogs: 0,
            ts: Date.now(),
          },
        },
        { upsert: true }
      )
    } catch (e) {
      console.error('[db] recordSkippedRound:', e.message)
    }
  }

  /** The headline numbers: hot dogs served, mouths fed, rounds run. */
  async function stats() {
    if (!ready) return { ready: false }
    try {
      const [agg] = await eaters
        .aggregate([
          {
            $group: {
              _id: null,
              hotDogs: { $sum: '$hotDogs' },
              usd: { $sum: '$totalUsd' },
              people: { $sum: 1 },
              meals: { $sum: '$meals' },
            },
          },
        ])
        .toArray()
      const [r] = await rounds
        .aggregate([{ $group: { _id: null, rounds: { $sum: 1 }, paid: { $sum: { $cond: ['$paid', 1, 0] } } } }])
        .toArray()
      return {
        ready: true,
        hotDogs: agg?.hotDogs || 0,
        usd: agg?.usd || 0,
        people: agg?.people || 0,
        meals: agg?.meals || 0,
        rounds: r?.rounds || 0,
        roundsPaid: r?.paid || 0,
      }
    } catch (e) {
      return { ready: false, error: e.message }
    }
  }

  /** Who has eaten the most. */
  async function leaderboard(limit = 100) {
    if (!ready) return { ready: false, rows: [] }
    const rows = await eaters.find({}).sort({ hotDogs: -1 }).limit(Math.min(limit, 500)).toArray()
    return {
      ready: true,
      rows: rows.map((r, i) => ({
        rank: i + 1,
        address: r._id,
        hotDogs: r.hotDogs || 0,
        totalUsd: r.totalUsd || 0,
        meals: r.meals || 0,
        firstAt: r.firstAt || null,
        lastAt: r.lastAt || null,
        lastHeldPct: r.lastHeldPct ?? null,
        lastRound: r.lastRound || null,
      })),
    }
  }

  /** One wallet's full history — every hot dog it has been handed. */
  async function walletHistory(address, limit = 200) {
    if (!ready) return { ready: false, rows: [] }
    const to = String(address || '').toLowerCase()
    const rows = await payouts.find({ to }).sort({ ts: -1 }).limit(Math.min(limit, 500)).toArray()
    const doc = await eaters.findOne({ _id: to })
    return { ready: true, address: to, summary: doc || null, rows }
  }

  /** Recent rounds, fed or not. */
  async function roundHistory(limit = 50) {
    if (!ready) return { ready: false, rows: [] }
    return { ready: true, rows: await rounds.find({}).sort({ roundId: -1 }).limit(Math.min(limit, 200)).toArray() }
  }

  /** The live feed on the frontend: the last N transfers, whoever they went to. */
  async function recentPayouts(limit = 60) {
    if (!ready) return { ready: false, rows: [] }
    return { ready: true, rows: await payouts.find({}).sort({ ts: -1 }).limit(Math.min(limit, 200)).toArray() }
  }

  return {
    connect,
    recordRound,
    recordSkippedRound,
    stats,
    leaderboard,
    walletHistory,
    roundHistory,
    recentPayouts,
    get ready() { return ready },
    get lastError() { return lastError },
    async close() { try { await client?.close() } catch {} },
  }
}
