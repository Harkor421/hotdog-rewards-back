// ============================================================================
// hub.js — one WebSocket server, one clock, everybody watching the same queue.
//
//   client connects       -> a `hello` snapshot (round, till, queue, totals)
//   client -> {op:'ping'} -> {type:'pong'}   keepalive
//
// HTTP on the same port answers the health check and exposes everything as
// JSON, because the frontend renders the live stream over the socket but reads
// its history over fetch, and because a page that claims to have handed out
// N hot dogs should let anyone check the number without a WebSocket client.
// ============================================================================

import http from 'http'
import { WebSocketServer } from 'ws'
import { config, BRAND } from './config.js'

export function createHub({ port, rounds, db }) {
  const clients = new Set()
  let distributor = null

  /** Everything a client needs the moment it connects. */
  function hello() {
    return {
      type: 'hello',
      ts: Date.now(),
      brand: BRAND,
      hotDogUsd: config.hotDogUsd,
      roundMs: config.roundMs,
      round: rounds.current,
      msLeft: rounds.msLeft,
      history: rounds.history.slice(0, 12),
      service: distributor?.snapshot() ?? null,
      pot: distributor?.potSnapshot() ?? null,
      lastRound: distributor?.lastRound() ?? null,
      session: distributor?.sessionTotals() ?? null,
      viewers: clients.size,
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')

    // The slow reads (/holders?token=, /simulate) can outlast the edge proxy's
    // timeout. When that happens the socket is already gone by the time the
    // promise settles, and writing to it throws ERR_HTTP_HEADERS_SENT — which
    // then fires the .catch, which writes again. One guard covers both.
    const json = (body, code = 200) => {
      if (res.headersSent || res.writableEnded) return
      res.writeHead(code, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,OPTIONS',
        'access-control-allow-headers': '*',
      })
      return res.end()
    }

    const p = url.pathname

    if (p === '/state') return json(hello())

    // The three numbers the page is built around. Served from the receipt book
    // when there is one, and from this process's own tally when there is not —
    // labelled, so a counter that restarted with the dyno can never be mistaken
    // for the all-time total.
    if (p === '/stats') {
      return db
        .stats()
        .then((s) =>
          json(
            s.ready
              ? { ...s, source: 'db', hotDogUsd: config.hotDogUsd }
              : { ...(distributor?.sessionTotals() ?? {}), ready: false, source: 'since-boot', hotDogUsd: config.hotDogUsd, note: 'No database attached — these totals reset when the server restarts.' }
          )
        )
        .catch((e) => json({ ready: false, error: e.message }))
    }

    if (p === '/rounds') {
      return db.roundHistory(Number(url.searchParams.get('limit') || 50)).then(json).catch((e) => json({ ready: false, rows: [], error: e.message }))
    }
    if (p === '/leaderboard') {
      return db.leaderboard(Number(url.searchParams.get('limit') || 100)).then(json).catch((e) => json({ ready: false, rows: [], error: e.message }))
    }
    if (p === '/recent') {
      return db.recentPayouts(Number(url.searchParams.get('limit') || 60)).then(json).catch((e) => json({ ready: false, rows: [], error: e.message }))
    }
    if (p.startsWith('/wallet/')) {
      return db.walletHistory(decodeURIComponent(p.slice('/wallet/'.length))).then(json).catch((e) => json({ ready: false, rows: [], error: e.message }))
    }

    // Holder detection, laid open: what was found, what was excluded and why.
    // `?token=0x…` probes ANY coin without configuring it.
    if (p === '/holders') {
      const probeToken = url.searchParams.get('token')
      if (probeToken) {
        return distributor
          .probe(probeToken, {
            startBlock: url.searchParams.get('from'),
            maxCalls: url.searchParams.get('calls'),
            timeoutMs: url.searchParams.get('timeout'),
          })
          .then(json)
          .catch((e) => json({ error: e.message, token: probeToken }))
      }
      return json(distributor?.diagnostics() ?? { error: 'no distributor' })
    }

    // A full dress rehearsal over a real coin's real holders.
    if (p === '/simulate') {
      return distributor
        .simulate({
          token: url.searchParams.get('token'),
          tillUsd: Number(url.searchParams.get('till') || 500),
          startBlock: url.searchParams.get('from'),
          hours: url.searchParams.get('hours'),
          days: url.searchParams.get('days'),
          maxCalls: url.searchParams.get('calls'),
          timeoutMs: url.searchParams.get('timeout'),
          stream: url.searchParams.get('stream') !== '0',
        })
        .then(json)
        .catch((e) => json({ error: e.message, simulated: true }))
    }

    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    res.end(
      `${BRAND.name} — a ${BRAND.item} every ${config.roundMs / 60000} minutes, for everyone holding $${BRAND.coin}.\n` +
        `${clients.size} viewer(s) · next bell in ${Math.ceil(rounds.msLeft / 1000)}s\n\n` +
        'Connect a WebSocket to this same URL for the live stream.\n' +
        'JSON: /state · /stats · /rounds · /leaderboard · /recent · /wallet/<address>\n' +
        'Holder detection: /holders  ·  probe any coin: /holders?token=0x…[&from=<launch block>]\n' +
        'Rehearse a round:  /simulate?token=0x…&days=7&till=500\n' +
        `Receipts: ${db?.ready ? 'persisted' : 'in memory only'}\n`
    )
  })

  const wss = new WebSocketServer({ server })

  wss.on('connection', (client) => {
    clients.add(client)
    try { client.send(JSON.stringify(hello())) } catch {}
    client.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.op === 'ping') {
        try { client.send(JSON.stringify({ type: 'pong', ts: Date.now() })) } catch {}
      }
    })
    client.on('close', () => clients.delete(client))
    client.on('error', () => clients.delete(client))
  })

  function broadcast(event) {
    if (clients.size === 0) return
    const data = JSON.stringify(event)
    for (const c of clients) {
      if (c.readyState === 1) {
        try { c.send(data) } catch {}
      }
    }
  }

  server.listen(port, () => console.info(`[hub] ${BRAND.name} listening on :${port}`))

  return {
    broadcast,
    attachDistributor(d) { distributor = d },
    get viewers() { return clients.size },
    close() {
      for (const c of clients) { try { c.close() } catch {} }
      wss.close()
      server.close()
    },
  }
}
