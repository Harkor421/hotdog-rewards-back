// ============================================================================
// index.js — wiring. clock -> counter -> hub -> browsers.
//
// There is no market feed here and no game to play. A round is five minutes of
// wall clock, and the only thing that happens at the end of one is that
// everybody holding the coin gets a hot dog.
// ============================================================================

import { config, BRAND } from './config.js'
import { createRounds } from './rounds.js'
import { createHub } from './hub.js'
import { createDistributor } from './distributor.js'
import { createDb } from './db.js'

let hub = null
let distributor = null

const rounds = createRounds({
  onEvent: (e) => {
    hub?.broadcast(e)
    // The bell IS the payout trigger. Fire-and-forget — the clock must never
    // wait on a chain, or a slow RPC would drag every future round late with it.
    if (e.type === 'roundEnd') distributor?.serve(e.round)
  },
})

const db = createDb(config.mongoUrl)
await db.connect()

hub = createHub({ port: config.port, rounds, db })
distributor = createDistributor({ onEvent: (e) => hub.broadcast(e), db })
hub.attachDistributor(distributor)

rounds.start()
distributor.start()

console.info(
  `[index] ${BRAND.name} ready — one ${BRAND.item} ($${config.hotDogUsd}) to every holder ` +
    `every ${config.roundMs >= 60_000 ? `${config.roundMs / 60_000} min` : `${config.roundMs / 1000}s`}.`
)

function shutdown() {
  console.info('\n[index] closing the counter')
  rounds.stop()
  distributor.stop()
  hub.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
