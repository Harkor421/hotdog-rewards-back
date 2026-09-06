// ============================================================================
// rounds.js — the clock. That is the whole game.
//
// Stock Royale needed a round engine because something had to WIN a round: a
// tape came in, armies moved, a winner was crowned and the winner decided what
// got bought. Hotdog Rewards has no contest. The bell rings, everybody eats.
//
// So what is left of that engine is the part that mattered anyway: rounds are
// aligned to the WALL CLOCK (…:00, :05, :10 …) rather than to the moment the
// process happened to boot. Every viewer in the world sees the same countdown
// hit zero at the same instant, a restart does not shift the schedule, and two
// instances of this server would agree on which round they are in.
// ============================================================================

import { config } from './config.js'

export function createRounds({ onEvent }) {
  const emit = (e) => onEvent({ ...e, ts: e.ts ?? Date.now() })

  /** The slot containing `ts`. Round boundaries are absolute, not relative. */
  const slotStart = (ts) => Math.floor(ts / config.roundMs) * config.roundMs

  let round = null
  let seq = 0
  let timer = null
  let ticker = null
  const history = []

  function meta(r = round) {
    if (!r) return null
    return {
      id: r.id,
      seq: r.seq,
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      lengthMs: config.roundMs,
      label: new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(r.startedAt)),
    }
  }

  function open(at = Date.now()) {
    const startedAt = slotStart(at)
    round = { id: startedAt / config.roundMs, seq: ++seq, startedAt, endsAt: startedAt + config.roundMs }
    emit({ type: 'roundStart', round: meta() })
  }

  function close() {
    if (!round) return
    const done = meta()
    history.unshift(done)
    if (history.length > config.historyLen) history.pop()
    // The bell IS the payout trigger. Everything downstream hangs off this.
    emit({ type: 'roundEnd', round: done })
    open(Date.now())
  }

  /**
   * Schedule the next boundary against the wall clock every time, rather than
   * setting a 5-minute interval once. setInterval drifts, and a laptop that
   * sleeps through two rounds would wake up handing out hot dogs on its own
   * private schedule, minutes out of step with everybody watching.
   */
  function schedule() {
    clearTimeout(timer)
    const wait = Math.max(50, round.endsAt - Date.now())
    timer = setTimeout(() => {
      close()
      schedule()
    }, wait)
  }

  return {
    start() {
      open(Date.now())
      schedule()
      // A one-second heartbeat so a client that connects mid-round, or one
      // whose tab was throttled in the background, snaps back onto the real
      // countdown instead of drifting off its own local timer.
      ticker = setInterval(() => emit({ type: 'tick', round: meta(), msLeft: Math.max(0, round.endsAt - Date.now()) }), 1000)
    },
    stop() {
      clearTimeout(timer)
      clearInterval(ticker)
    },
    get current() { return meta() },
    get msLeft() { return round ? Math.max(0, round.endsAt - Date.now()) : 0 },
    get history() { return history },
  }
}
