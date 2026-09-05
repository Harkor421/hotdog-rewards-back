# 🌭 COSTCO — Backend

**Every five minutes, a hot dog.** One dollar, to every wallet holding
[`$COSTCO`](#the-coin). Not a slice of a pot weighted by how rich you are — the
same dollar for everyone in the queue, because that is what a hot dog costs and
everybody is buying the same hot dog.

The machinery underneath is [Stock Royale](https://github.com/Harkor421/stock-royale-back)'s,
carried over where it matters. That project bought the winning stock at the bell
and split it pro-rata among a memecoin's holders; this one skips the contest and
hands out a flat dollar. **The half that decides *who* gets paid is unchanged** —
the same three holder sources, the same pool and bonding-curve exclusion, the
same `eth_getCode` on every recipient, the same four refusals. That code was
expensive to get right and none of what it knows stopped being true.

The half that decides *how much* is new, and it is new for one reason: **a flat
payout is a different animal from a pro-rata one.** See [the sybil floor](#the-sybil-floor).

---

## Setup

```bash
npm install
cp .env.example .env
```

```bash
npm start          # the real thing
DEMO_HOLDERS=40 PAYOUTS=1 npm start    # a synthetic queue, so the frontend can be built
```

The hub listens on `ws://localhost:8080`. Connect and you get a `hello` snapshot
(round clock, till, queue, totals) and then the live stream. Everything is also
readable as JSON — see [the endpoints](#the-endpoints).

## Arming it

Two switches, both off by default, and neither is flipped by accident:

| | |
| --- | --- |
| `PAYOUTS=1` | turns the counter on. Without it the clock still runs and the till is still published — you can watch it do nothing. |
| `DRY_RUN=false` | is what actually lets money leave. |

`DRY_RUN` also stays on implicitly whenever there is no treasury key or no
`TOKEN` configured, so a half-finished `.env` cannot spend anything.

**Run it dry for a few rounds first.** A dry round streams exactly the events a
real one does, with a synthetic till (`DEMO_TILL_USD`), so the page fills in and
you can read the recipient list before a cent moves.

---

## The round

Five minutes, aligned to the **wall clock** (…:00, :05, :10 …), not to the moment
the process booted. Every viewer in the world sees the same countdown hit zero at
the same instant, a redeploy does not shift the schedule, and the round the
server thinks it is in is a pure function of the time.

The bell is the only trigger in the system. There is nothing to win.

```
roundEnd ──▶ who holds the coin
         ──▶ drop the pools, the curves, the contracts, the dust
         ──▶ re-read every remaining balance off the chain
         ──▶ send each of them a dollar
```

## What a dollar is made of

| `PAYOUT_ASSET` | |
| --- | --- |
| **`native`** *(default)* | $1 worth of the chain's native coin. Needs no pool, no swap and no stablecoin to exist — the ETH/USD price turns a dollar into wei. **Works on day one, on any EVM chain, with nothing deployed.** |
| `erc20` | Pay in a USD-pegged token (`PAYOUT_TOKEN`), which the treasury buys with ETH through the same Algebra router Stock Royale buys stock with. Use this once the chain has a stablecoin with real liquidity — "1.00 USDC" reads better in a wallet than "0.00023 ETH". |

In `erc20` mode the treasury buys the **shortfall**, not the whole bill: it
usually still holds change from the last round, and swapping through a thin pool
twelve times an hour for money it already has is a slippage tax.

## The brake

`MAX_ROUND_PCT` (default **4%**) is the most one round may ever spend, whatever
the queue length says it is owed.

Without it, one round can empty the till. The treasury does not choose how many
holders exist, and a coin that doubles its holders overnight doubles the bill
with no warning. At 4% a round the till survives ~25 rounds even if nothing is
ever added to it — and `roundsLeft` in `/state` publishes that runway, because it
is the number that decides whether holding the coin is worth anything.

**When the brake bites, everybody eats less** — the round's budget is split
equally rather than paying the first N wallets a whole dollar and the rest
nothing. Half a hot dog each is a worse day; half the queue going hungry while
the other half eats is a different product. The round is flagged `shortfall:true`
and the page says so.

---

## The sybil floor

**This is the number that matters most, and it did not matter at all in Stock Royale.**

A pro-rata split defends itself. Split your bag across a hundred wallets and you
get exactly the slice you had before, so nobody bothers. A **flat dollar per
wallet is the opposite: a hundred wallets is a hundred dollars.** The only thing
standing between this treasury and a wallet generator is a floor on how much of
the supply you have to hold to be a mouth worth feeding.

`MIN_ELIGIBLE_PCT` (default **0.1%**) is that floor, and it does two jobs:

1. **It prices the attack.** To farm an extra dollar every five minutes you must
   buy another 0.1% of the supply and keep holding it — at which point you are
   not an attacker, you are the customer.
2. **It caps the bill.** At 0.1%, at most **1,000 wallets can ever qualify**, so
   a round can never cost more than $1,000 no matter what happens.

`MAX_RECIPIENTS` (default 500) is the belt to that pair of braces: if the queue
is somehow longer, the largest holders are served and the page is told the queue
was **cut**, rather than being shown a shorter queue and no explanation.

The server refuses to start with `MIN_ELIGIBLE_PCT=0` in flat mode.

> **What this floor does not solve.** It is a floor on *size*, not on *time*.
> Nothing here stops someone buying in seconds before the bell, eating, and
> selling — holder snapshots are taken on a poll, not at a block height, and
> there is no minimum holding period. If that becomes the dominant behaviour,
> the fix is a time-weighted snapshot (sample the holder set through the round
> and pay the intersection), not a bigger floor.

---

## Who actually holds the coin

This is the part that cost the most debugging time in Stock Royale, and every
word of it is still true here. The short version:

**The indexer will not talk to you.** `robinhoodchain.blockscout.com` sits behind
a Cloudflare challenge and answers a server **403** with an HTML *"Just a
moment…"* page. Nothing identifies itself as an error — the crawl comes back
empty, which downstream looks exactly like *a coin with no holders*. That is the
failure mode to recognise. `api.blockscout.com/4663` answers **402** without a
key, which at least says what is wrong. **Set `BLOCKSCOUT_API_KEY`** and this
path works.

**Without one, holders are read straight off the chain.** No key, no third party.
The insight that makes this fast: `balanceOf` already returns the state of the
world right now, so history is only needed to learn *which addresses to ask
about*. The log scan is demoted to discovery — it walks back just far enough to
have found the addresses holding the supply — and every balance comes from the
chain. Measured on a live 2-day-old token: **6.3s to 100% of supply**, against
32s for replaying every transfer, with identical results.

**Pools and bonding curves are not holders.** On a launchpad coin the bonding
curve holds most of the supply, and after graduation the AMM pool does. Three
overlapping rules, so no single one being wrong lets a curve into the queue:

1. Any **contract** holding ≥ `POOL_MIN_PCT` (0.5%) of supply.
2. The **single largest contract holder**, whatever its size.
3. **Known addresses re-checked on-chain** — the important one being
   `0x8366a3…40951`, Robinhood Chain's Uniswap v4 singleton PoolManager. *All*
   v4 liquidity for *every* token lives in that one contract.

Rule 1 is the one that survives a launchpad shipping a v2: it needs no prior
knowledge of any address.

**And then every recipient is checked individually.** The rules above catch
infrastructure by *size*, which leaves a gap: a router, a vault or a multisig
holding a modest share is not a pool by that rule and is not a person either. So
`eth_getCode` runs on **every** address about to be paid. On a live token this
rejected two contracts holding 0.275% and 0.236% — both under the pool
threshold, both otherwise about to be fed.

**The chain decides the amounts.** Balances for everyone about to be paid are
re-read from the chain before the split (`VERIFY_ONCHAIN`). The indexer decides
*who* is in the queue; the chain decides whether they still qualify.

### It refuses rather than guesses

| Refusal | Why |
| --- | --- |
| crawl covers < `MIN_SUPPLY_COVERAGE` (40%) | a **truncated crawl**, not a coin with a tiny float. Feeding over it hands every hot dog to whichever addresses landed on the first page. |
| holder count collapses to < 30% of the last crawl | an indexer problem far more often than a real exodus. |
| snapshot older than `HOLDERS_STALE_MS` | never distribute over frozen data. |
| discovery accounted for < `DISCOVERY_TARGET` (99.5%) of supply | unaccounted supply is not noise — it is wallets nobody has looked at, and in flat mode every one is a person who goes hungry. Stopping at 83% once hid the holder owed 89% of an airdrop. |

Every refusal is recorded as an unpaid round with its reason, so an empty history
means *"nobody has been fed"* and never *"the recorder is broken"*.

---

## The endpoints

| | |
| --- | --- |
| `GET /state` | the `hello` snapshot: round clock, till, queue, runway |
| `GET /stats` | **hot dogs served · people fed · rounds run.** Says `source:"since-boot"` when there is no database, so a counter that restarted with the dyno can never pass as an all-time total |
| `GET /rounds` | every round, fed or refused, with the reason |
| `GET /leaderboard` | who has eaten the most |
| `GET /recent` | the last transfers, for the live feed |
| `GET /wallet/<address>` | one wallet's every hot dog |
| `GET /holders` | what the live snapshot found, and what it excluded and why |
| `GET /holders?token=0x…` | probe **any** coin without configuring it. `&from=<launch block>` is the difference between a useful probe and a timeout |
| `GET /simulate?token=0x…&days=7&till=500` | [rehearse a round](#rehearsing-a-round) |

### The event stream

| Event | When |
| --- | --- |
| `hello` | on connect — everything at once |
| `tick` | 1/s — the countdown, so a throttled tab snaps back instead of drifting |
| `roundStart` / `roundEnd` | every 5 minutes, on the wall clock |
| `serveStart` | the bell: how many mouths, how much each, and whether the brake bit |
| `servePayment` | each transfer, streamed as it is broadcast |
| `serveResult` | the round's total |
| `serveError` | a round that fed nobody, and why |
| `pot` | the till and its runway |
| `holders` | the queue was re-counted |

## Rehearsing a round

Before pointing real money at a coin, run the whole thing against its **real
holders** without moving anything:

```
GET /simulate?token=0x…&days=7&till=500
```

`&days=` is how far back to read the coin's history — nobody knows their launch
block offhand, but everybody knows roughly when it launched.

It is not a mock. Same holder detection, same exclusions, same on-chain balance
check, same split — everything except the transfers. It answers: **who holds the
coin**, **who would be fed**, **what it would cost**, and **how many rounds the
till has left**. And it **refuses over a partial view**, held to the same coverage
floor a live round is held to, because a rehearsal built from whoever happened to
trade inside the scanned window is a confident wrong answer.

---

## Deploy to Railway

It holds open WebSockets and runs a round clock, so it needs a long-lived
process — serverless cannot host it. The server binds `process.env.PORT` and
answers `GET /`, so Railway deploys it as-is.

1. `railway init` → `railway up`, or connect the GitHub repo.
2. Set at minimum: `TOKEN`, `DISTRIBUTOR_PRIVATE_KEY`, `PAYOUTS`, `DRY_RUN`.
3. Networking → generate a domain. The frontend's `NEXT_PUBLIC_BACKEND_URL` is
   `wss://<domain>`.

Add a MongoDB service and set `MONGO_URL` to keep the totals across deploys.
Without it everything still runs and `/stats` labels its numbers `since-boot`.
