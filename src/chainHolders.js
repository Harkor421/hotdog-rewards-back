// ============================================================================
// chainHolders.js — holder detection with no indexer at all.
// Lifted verbatim from Stock Royale: it knows nothing about stocks or hot dogs,
// only about reading an ERC-20's holder set off a chain that will not index it.
//
// WHY THIS EXISTS. Robinhood Chain's public Blockscout sits behind a Cloudflare
// challenge and answers a server 403 with an HTML "Just a moment…" page; the
// Pro API answers 402 without a paid key. So the usual approach — crawl the
// explorer's /holders endpoint — fails, and it fails *quietly*, looking exactly
// like a token with no holders. That has cost real debugging time.
//
// This reads the chain instead. Every ERC-20 balance is the sum of its Transfer
// events, so replaying those logs reconstructs the holder set exactly, from
// ground truth, with no third party in the path and no API key.
//
//   1. walk BACKWARDS from the head until the token goes quiet — that is where
//      its history starts
//   2. replay Transfer logs forward from there, adaptive range sizing
//   3. keep the balances and a cursor, so later polls only scan new blocks
//
// It is slower to start than an indexer and then cheaper than one forever.
//
// NOTE ON THIS RPC. The public node is NOT an archive node: historical STATE is
// pruned after roughly ten minutes of blocks, so eth_getCode at an old block
// errors out and the deployment block cannot be binary-searched. Historical
// LOGS are still served, which is why this works at all — and why the start of
// history is found by looking for silence rather than for code.
// ============================================================================

import { ethers } from 'ethers'

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

export function createChainHolders({ provider, chainId }) {
  /** token (lowercase) -> { balances:Map, cursor:number, deployBlock:number } */
  const cache = new Map()

  /**
   * The block a contract first had code at — only answerable on an ARCHIVE node.
   * A pruned node errors on old blocks, and an error must never be read as
   * "not deployed yet": that turns a missing-data problem into a confident
   * wrong answer, which is worse than failing.
   */
  async function findDeployBlock(token, head) {
    if ((await provider.getCode(token, head)) === '0x') throw new Error('no contract code at this address')
    let lo = 0
    let hi = head
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      let code
      try {
        code = await provider.getCode(token, mid)
      } catch (e) {
        throw new Error('this RPC has no archive state — cannot binary-search the deployment block')
      }
      if (code === '0x') lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Where the token's history starts, found without archive state: step
   * backwards from the head and stop after enough consecutive windows with no
   * Transfer at all. A token that has been quiet for that long has no earlier
   * balances that still matter — and if it does, `startBlock` overrides this.
   */
  async function findFirstActivity(token, head, { window = 20_000, quietWindows = 6, maxLookback = 20_000_000, maxStep = 1_500_000, deadline = 0 } = {}) {
    let quiet = 0
    let cursor = head
    let earliest = head
    let span = window
    const floor = Math.max(0, head - maxLookback)
    while (cursor > floor) {
      // a diagnostic that never returns is not a diagnostic
      if (deadline && Date.now() > deadline) return earliest
      const from = Math.max(floor, cursor - span + 1)
      let logs = null
      try {
        logs = await provider.getLogs({ address: token, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: cursor })
      } catch (e) {
        // Any refusal here means the window was too much to answer, never that
        // it was empty — a busy window and a broken window look the same from
        // outside, and only one of them is safe to treat as silence.
        if (span > 500) {
          span = Math.floor(span / 2)
          continue
        }
        // can't narrow further: assume activity and keep walking back
        quiet = 0
        earliest = from
        cursor = from - 1
        span = window
        continue
      }
      if (logs.length) {
        quiet = 0
        earliest = from
        // back to careful steps: we are inside the token's active history
        span = Math.min(window, Math.max(window, span))
        if (logs.length < 1500) span = window
      } else {
        quiet++
        if (quiet >= quietWindows) break
        // Nothing here. A coin can be months old and silent for most of it, so
        // reach back exponentially while it stays quiet — fixed steps would
        // need thousands of calls to cross that. The step collapses back to
        // `window` the moment a transfer shows up, so the start stays precise.
        span = Math.min(maxStep, span * 3)
      }
      cursor = from - 1
    }
    return earliest
  }

  /**
   * Replay Transfer logs over a block range, halving the window whenever the
   * node refuses it. Robinhood Chain caps a query at 10,000 logs and times out
   * on wide ranges, so the window has to adapt rather than be guessed.
   */
  async function scanRange(token, from, to, onLog, opts = {}) {
    const maxSpan = opts.maxSpan ?? 40_000
    const minSpan = 128
    let cursor = from
    let span = maxSpan
    let calls = 0
    while (cursor <= to) {
      if (opts.deadline && Date.now() > opts.deadline) return { cursor, calls, exhausted: true }
      const end = Math.min(cursor + span - 1, to)
      try {
        const logs = await provider.getLogs({
          address: token,
          topics: [TRANSFER_TOPIC],
          fromBlock: cursor,
          toBlock: end,
        })
        calls++
        for (const l of logs) onLog(l)
        cursor = end + 1
        // widen again after a clean pass — most ranges are quiet
        if (logs.length < 3000 && span < maxSpan) span = Math.min(maxSpan, span * 2)
        if (opts.maxCalls && calls >= opts.maxCalls) return { cursor, calls, exhausted: true }
      } catch (e) {
        const msg = String(e?.message || e).toLowerCase()
        const tooMuch = /exceed|limit|timed out|timeout|too many|range/.test(msg)
        if (tooMuch && span > minSpan) {
          span = Math.max(minSpan, Math.floor(span / 2))
          continue
        }
        if (tooMuch) {
          // a single block over the log cap: nothing sensible left to do but
          // step past it rather than spin forever
          cursor = end + 1
          continue
        }
        throw e
      }
    }
    return { cursor, calls, exhausted: false }
  }

  /**
   * Current balances for every address that has ever held the token.
   * Incremental: the first call replays history, later calls only scan forward.
   */
  async function balances(tokenAddress, opts = {}) {
    const { maxCalls = 900, onProgress } = opts
    const token = tokenAddress.toLowerCase()
    const head = await provider.getBlockNumber()
    let entry = cache.get(token)

    if (!entry) {
      const startBlock =
        opts.startBlock != null
          ? opts.startBlock
          : await findFirstActivity(token, head, {
              maxLookback: opts.maxLookback ?? 20_000_000,
              deadline: opts.deadline ?? 0,
            })
      entry = { balances: new Map(), cursor: startBlock, deployBlock: startBlock }
      cache.set(token, entry)
      onProgress?.({ phase: 'start-block', startBlock, blocksToScan: head - startBlock })
    }
    if (entry.cursor > head) return snapshot(entry, head, false)

    const add = (addr, delta) => {
      if (addr === ethers.ZeroAddress) return // mint/burn counterparty
      const a = addr.toLowerCase()
      const next = (entry.balances.get(a) ?? 0n) + delta
      if (next > 0n) entry.balances.set(a, next)
      else entry.balances.delete(a)
    }

    const res = await scanRange(
      token,
      entry.cursor,
      head,
      (l) => {
        // topics: [Transfer, from, to]; data: value
        const from = '0x' + l.topics[1].slice(26)
        const to = '0x' + l.topics[2].slice(26)
        const value = BigInt(l.data === '0x' ? 0 : l.data)
        if (value === 0n) return
        add(from, -value)
        add(to, value)
      },
      { maxCalls, onProgress, deadline: opts.deadline ?? 0 }
    )
    entry.cursor = res.cursor
    return snapshot(entry, head, res.exhausted)
  }

  function snapshot(entry, head, partial) {
    return {
      map: new Map(entry.balances),
      deployBlock: entry.deployBlock,
      scannedTo: entry.cursor - 1,
      head,
      /** true when the scan hit its call budget and has more history to walk */
      partial,
      complete: !partial && entry.cursor > head,
    }
  }

  /**
   * Current holders, WITHOUT replaying the token's history.
   *
   * The insight the first version missed: balanceOf already returns the state
   * of the world right now. History is only needed to learn WHICH addresses to
   * ask about. So the log scan is demoted to discovery — it walks back just far
   * enough to have found the addresses that hold the supply — and every balance
   * comes from the chain directly.
   *
   * That converges far faster, because a wallet that has held since day one but
   * traded once this morning is found in the first window with its FULL balance.
   * Replaying deltas would have credited it only what moved inside the window,
   * and would have had to reach all the way back to get the rest.
   *
   * It stops as soon as the addresses found account for `targetCoverage` of
   * supply — usually a handful of windows, whatever the token's age.
   */
  async function currentBalances(token, opts = {}) {
    const {
      totalSupply,
      targetCoverage = 0.97,
      window = 60_000,
      maxWindows = 22,
      maxStep = 2_000_000,
      quietToStop = 3,
      deadline = 0,
      onProgress,
    } = opts
    if (!totalSupply || totalSupply <= 0n) throw new Error('need the token total supply to know when to stop')

    const head = await provider.getBlockNumber()
    const seen = new Set()
    const balances = new Map()
    const erc20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], provider)

    let held = 0n
    let cursor = head
    let span = window
    let windows = 0
    let coverage = 0
    let quietWindows = 0

    let found = 0
    const askChain = async (addrs) => {
      const CONC = 10
      for (let i = 0; i < addrs.length; i += CONC) {
        await Promise.all(
          addrs.slice(i, i + CONC).map(async (a) => {
            try {
              const b = await erc20.balanceOf(a)
              if (b > 0n) {
                if (!balances.has(a)) {
                  held += b
                  found++
                }
                balances.set(a, b)
              }
            } catch {}
          })
        )
      }
    }

    while (windows < maxWindows && cursor > 0) {
      if (deadline && Date.now() > deadline) break
      const from = Math.max(0, cursor - span + 1)
      let logs = null
      try {
        logs = await provider.getLogs({ address: token, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: cursor })
      } catch {
        if (span > 500) {
          span = Math.floor(span / 2)
          continue
        }
        cursor = from - 1
        continue
      }

      found = 0
      const fresh = []
      for (const l of logs) {
        for (const t of [l.topics[1], l.topics[2]]) {
          if (!t) continue
          const a = ('0x' + t.slice(26)).toLowerCase()
          if (a === ethers.ZeroAddress) continue
          if (!seen.has(a)) {
            seen.add(a)
            fresh.push(a)
          }
        }
      }
      if (fresh.length) await askChain(fresh)

      coverage = Number((held * 10000n) / totalSupply) / 100
      if (found) quietWindows = 0
      else quietWindows++
      onProgress?.({ windows: windows + 1, from, addresses: seen.size, holders: balances.size, coveragePct: coverage })

      // Coverage alone is the wrong stopping rule. The last fraction of a
      // percent is not noise — it is small holders, and each of them is a
      // person owed a cut. So keep going until the supply is accounted for AND
      // the search has stopped turning up anybody new.
      if (coverage >= targetCoverage * 100 && quietWindows >= quietToStop) break

      cursor = from - 1
      // quiet stretch: reach back harder. busy stretch: keep steps careful.
      span = logs.length ? window : Math.min(maxStep, span * 3)
      windows++
    }

    return {
      map: balances,
      head,
      scannedFrom: cursor,
      scannedTo: head,
      coveragePct: coverage,
      complete: coverage >= targetCoverage * 100 && quietWindows >= quietToStop,
      addressesConsidered: seen.size,
    }
  }

  /** Which of these addresses are contracts? Used to spot pools and curves. */
  async function contractsAmong(addresses) {
    const out = new Set()
    const list = [...addresses]
    const CONC = 8
    for (let i = 0; i < list.length; i += CONC) {
      await Promise.all(
        list.slice(i, i + CONC).map(async (a) => {
          try {
            if ((await provider.getCode(a)) !== '0x') out.add(a.toLowerCase())
          } catch {}
        })
      )
    }
    return out
  }

  return { balances, currentBalances, contractsAmong, findDeployBlock, findFirstActivity, reset: () => cache.clear(), chainId }
}
