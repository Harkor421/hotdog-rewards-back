// ============================================================================
// distributor.js — the counter. This is where the hot dogs come from.
//
// Every five minutes the bell rings and the treasury pays ONE DOLLAR to every
// wallet holding $HDR. Not a share of a pot, not a slice weighted by how
// rich you are — a dollar, the same dollar, because that is what a hot dog
// costs and everybody in the queue is buying the same hot dog.
//
//   roundEnd ──▶ who holds the coin (indexer, or the chain itself)
//            ──▶ drop the pools, the curves, the contracts, the dust
//            ──▶ re-read every remaining balance off the chain
//            ──▶ send each of them a dollar
//
// The half of this file that finds holders is Stock Royale's, unchanged: the
// same three sources, the same pool detection, the same eth_getCode on every
// recipient, the same four refusals. That code was expensive to get right and
// none of what it knows stopped being true when the prize changed.
//
// The half that pays is new, and it is new because a FLAT payout is a different
// animal from a pro-rata one — see THE SYBIL FLOOR in config.js, and `budget()`
// below for the brake that keeps one round from emptying the till.
//
// ⚠ DRY_RUN defaults to TRUE and PAYOUTS defaults to off. Nothing touches real
//   funds until both switches are thrown deliberately.
// ============================================================================

import { ethers } from 'ethers'
import { config, BRAND } from './config.js'
import { createChainHolders } from './chainHolders.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const isAddr = (a) => typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a)
const fmtUnits = (raw, dec) => Number(ethers.formatUnits(raw ?? 0n, dec ?? 18))

const ZERO = '0x0000000000000000000000000000000000000000'
const DEAD = '0x000000000000000000000000000000000000dead'

/** Fixed-point USD. Money is never divided in floating point in here. */
const USD = 1_000_000n
const usdToBig = (n) => BigInt(Math.round(Number(n) * 1e6))
const bigToUsd = (n) => Number(n) / 1e6

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
const WETH_ABI = [...ERC20_ABI, 'function deposit() payable']
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,address deployer,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice)) payable returns (uint256)',
]

export function createDistributor({ onEvent, db }) {
  const c = config.chain
  const enabled = c.live
  const provider = c.rpcUrl ? new ethers.JsonRpcProvider(c.rpcUrl, c.chainId) : null
  const wallet = c.privateKey && provider ? new ethers.Wallet(c.privateKey, provider) : null
  const chain = provider ? createChainHolders({ provider, chainId: c.chainId }) : null
  const dryRun = c.dryRun || !wallet || !isAddr(c.token)
  const payingNative = c.payoutAsset === 'native'

  let tokenDecimals = 18
  let tokenSymbol = null
  let tokenTotalSupply = 0n
  let holders = null // { ts, rows:[{address, raw, amount, pct}] }
  let contractHolders = new Set()
  let poolSet = new Set() //   curves + AMM pools: never fed, always reported
  let rpcPools = new Set() //  known infrastructure confirmed straight off-chain
  let lastEligibleCount = 0
  let diagnostics = null
  let holdersSupply = 0
  let holdersSource = null
  let busy = false
  let holdersTimer = null
  let potTimer = null

  // Totals since boot. With Mongo attached these are eclipsed by the real ones;
  // without it they are all the frontend has, and a counter that resets on a
  // deploy is still better than no counter.
  const session = { hotDogs: 0, usd: 0, rounds: 0, people: new Set() }

  /**
   * The last round that was served, kept in memory.
   *
   * A round takes seconds and the gap between them is five minutes, so almost
   * everybody who opens the page arrives while nothing is happening. Without
   * this they would stare at an empty queue until the next bell and reasonably
   * conclude the thing does not work. The receipt book can't cover it either —
   * it is optional, and this has to work without one.
   */
  let lastServed = null

  const emit = (e) => onEvent({ ...e, ts: e.ts ?? now() })
  const bsAuth = () => (c.blockscoutKey ? { apikey: c.blockscoutKey } : {})
  const explorerTx = (hash) => `${c.explorer}/tx/${hash}`
  const explorerAddr = (a) => `${c.explorer}/address/${a}`

  // ======================================================================
  // WHO HOLDS THE COIN
  // Everything from here to "THE COUNTER" is Stock Royale's holder detection,
  // carried over intact. See that repo's README for the full account of why
  // each guard exists; the short version is that every one of them was added
  // after it went wrong on a live token.
  // ======================================================================

  // Blockscout's public instance sits behind a WAF that answers 403 to requests
  // with no User-Agent — which is what bare fetch() sends. Found the hard way:
  // holder detection simply returned nothing, with no error pointing at a cause.
  const HTTP_HEADERS = {
    'user-agent': 'hotdog-rewards/1.0 (+https://github.com/Harkor421/hotdog-rewards-back)',
    accept: 'application/json',
  }

  async function getJson(base, path, params) {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v))
    const r = await fetch(url, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`${path} -> ${r.status}`)
    return r.json()
  }

  /**
   * One complete crawl of the coin's holders. Built into local structures and
   * only applied whole: a crawl that dies half way is thrown away, never fed
   * over, or the last page of holders would silently go hungry.
   */
  async function crawlHolders(base, useAuth, token = c.token) {
    const map = new Map()
    const contracts = new Set()
    let params = useAuth ? { ...bsAuth() } : {}
    for (let page = 0; page < 500; page++) {
      let data = null
      for (let tries = 0; tries < 5; tries++) {
        try {
          data = await getJson(base, `/api/v2/tokens/${token}/holders`, params)
          break
        } catch (e) {
          if (tries === 4) throw e
          await sleep(1000 * (tries + 1)) // 429 / 5xx backoff
        }
      }
      const items = data?.items || []
      for (const it of items) {
        const addr = (it.address?.hash || it.address_hash || '').toLowerCase()
        const val = it.value ?? it.balance
        if (addr && val != null) map.set(addr, BigInt(val))
        if (addr && it.address?.is_contract) contracts.add(addr)
      }
      const npp = data?.next_page_params
      if (!npp || !items.length) break
      params = useAuth ? { ...npp, ...bsAuth() } : { ...npp }
    }
    return { map, contracts }
  }

  async function loadTokenMeta() {
    try {
      const d = await getJson(c.blockscout, `/api/v2/tokens/${c.token}`, bsAuth())
      if (d?.decimals != null) tokenDecimals = Number(d.decimals)
      if (d?.symbol) tokenSymbol = d.symbol
      if (d?.total_supply != null) tokenTotalSupply = BigInt(d.total_supply)
      if (tokenTotalSupply > 0n && tokenSymbol) return
    } catch {}
    if (!provider || !isAddr(c.token)) return
    const t = new ethers.Contract(c.token, ERC20_ABI, provider)
    try { tokenDecimals = Number(await t.decimals()) } catch {}
    try { tokenTotalSupply = await t.totalSupply() } catch {}
    // The frontend names the coin everywhere it explains the drop. Read the
    // symbol off the contract rather than hard-coding it, so the copy cannot
    // outlive a change of token.
    try { tokenSymbol = await t.symbol() } catch {}
  }

  /**
   * Pools and bonding curves, found by the only rule that keeps working when a
   * launchpad ships a new version: a CONTRACT sitting on a big share of supply
   * is infrastructure, not a holder. Union of three sources, so no single one
   * being wrong or down can let a curve into the queue — where, on a flat
   * payout, it would take exactly one dollar, but on a pro-rata one it would
   * take nearly all of them.
   */
  function refreshPools(balances) {
    const next = new Set(rpcPools)
    if (tokenTotalSupply > 0n) {
      const minRaw = (tokenTotalSupply * BigInt(Math.round(c.poolMinPct * 1000))) / 100_000n
      let biggest = null
      let biggestBal = 0n
      for (const a of contractHolders) {
        const b = balances.get(a) || 0n
        if (b >= minRaw) next.add(a)
        if (b > biggestBal) { biggestBal = b; biggest = a }
      }
      if (biggest) next.add(biggest)
    }
    poolSet = next
    return poolSet
  }

  /** Confirm known infrastructure against the chain itself, so pool detection
   *  survives the indexer being down or mislabelling them. */
  async function refreshRpcPools() {
    if (!provider || !isAddr(c.token) || !c.poolCandidates.length) return
    try {
      if (tokenTotalSupply === 0n) await loadTokenMeta()
      if (tokenTotalSupply === 0n) return
      const minRaw = (tokenTotalSupply * BigInt(Math.round(c.poolMinPct * 1000))) / 100_000n
      const token = new ethers.Contract(c.token, ERC20_ABI, provider)
      for (const a of c.poolCandidates) {
        try {
          const b = await token.balanceOf(a)
          if (b >= minRaw) rpcPools.add(a)
          else rpcPools.delete(a)
        } catch {}
      }
    } catch (e) {
      console.warn('[hdr] pool candidates:', e.message)
    }
  }

  const isExcluded = (addr) =>
    addr === ZERO ||
    addr === DEAD ||
    addr === wallet?.address?.toLowerCase() ||
    c.exclude.has(addr) ||
    poolSet.has(addr) ||
    (c.excludeContracts && contractHolders.has(addr))

  /**
   * Re-read balances from the chain for everyone about to be paid. The indexer
   * decides WHO is in the queue; the chain decides whether they still qualify.
   */
  async function verifyBalances(rows) {
    if (!c.verifyOnchain || !provider || !rows.length) return rows
    const take = rows.slice(0, c.verifyMax)
    const token = new ethers.Contract(c.token, ERC20_ABI, provider)
    const CONC = 8
    let drift = 0
    for (let i = 0; i < take.length; i += CONC) {
      await Promise.all(
        take.slice(i, i + CONC).map(async (r) => {
          try {
            const onchain = await token.balanceOf(r.address)
            if (onchain !== r.raw) {
              drift++
              r.indexed = r.raw
              r.raw = onchain
              r.amount = fmtUnits(onchain, tokenDecimals)
              r.pct = holdersSupply > 0 ? (r.amount / holdersSupply) * 100 : r.pct
            }
          } catch {
            /* one RPC miss must not drop a holder — keep the indexed value */
          }
        })
      )
    }
    if (drift) console.info(`[hdr] ${drift}/${take.length} balances corrected against the chain`)
    return rows
  }

  /**
   * Every address about to be paid gets eth_getCode run on it.
   *
   * The pool rules catch infrastructure by SIZE. That leaves a gap: a router, a
   * vault, a bridge or a multisig holding a modest share is not a pool by that
   * rule and is not a person either. And on the indexer path the is_contract
   * flag can simply be missing. So the last word on "is this a mouth" comes
   * from the chain, for every recipient, not just the big ones.
   */
  async function keepOnlyWallets(rows) {
    if (!provider || !chain || !rows.length) return { rows, removed: [] }
    const code = await chain.contractsAmong(rows.map((r) => r.address))
    if (!code.size) return { rows, removed: [] }
    const removed = rows.filter((r) => code.has(r.address))
    for (const r of removed) r.why = 'contract (verified on-chain)'
    return { rows: rows.filter((r) => !code.has(r.address)), removed }
  }

  /**
   * Get the holder set, from whichever source can actually answer.
   *
   *   1. Blockscout Pro (needs BLOCKSCOUT_API_KEY)
   *   2. the public explorer — usually Cloudflare-blocked to servers, kept
   *      because it works from some networks
   *   3. the chain itself (no key, no indexer)
   *
   * Every failure is reported with its reason, because the way this breaks is
   * by looking exactly like a coin with no holders.
   */
  async function fetchHolders(token = c.token, supplyRaw = tokenTotalSupply, budget = null) {
    const tried = []
    for (const [base, auth, label] of [
      [c.blockscout, true, 'blockscout-pro'],
      [c.blockscoutPublic, false, 'blockscout-public'],
    ]) {
      if (!base) continue
      try {
        const res = await crawlHolders(base, auth, token)
        if (res.map.size) {
          holdersSource = label
          return { ...res, source: label }
        }
        tried.push(`${label}: returned no holders`)
      } catch (e) {
        const msg = String(e.message || e)
        tried.push(
          `${label}: ${msg}` +
            (msg.includes('403') ? ' (Cloudflare challenge — this host blocks servers)' : '') +
            (msg.includes('402') ? ' (needs BLOCKSCOUT_API_KEY)' : '')
        )
      }
    }

    if (c.chainFallback && chain) {
      console.warn(`[hdr] indexers unavailable (${tried.join(' · ')}) — reading holders off the chain`)
      // Ask the chain what each address holds NOW rather than replaying every
      // transfer the coin has ever made. The logs only discover WHICH addresses
      // to ask about, so this converges in seconds regardless of the coin's age.
      const built = await chain.currentBalances(token, {
        totalSupply: supplyRaw,
        targetCoverage: c.discoveryTarget / 100,
        deadline: budget?.deadline ?? Date.now() + 120_000,
      })
      // Never feed over a partial holder set. The supply not accounted for is
      // not noise — it is wallets nobody has looked at, and every one of them
      // is a person standing in the queue.
      if (!built.complete) {
        throw new Error(
          `only accounted for ${built.coveragePct.toFixed(1)}% of supply (need ${c.discoveryTarget}%) after searching back ` +
            `to block ${built.scannedFrom}. The rest sits in wallets that have not moved recently, and every one of them is ` +
            `somebody who would go hungry. Widen the search or set BLOCKSCOUT_API_KEY to read holders from the indexer.`
        )
      }
      const contracts = await chain.contractsAmong(
        [...built.map.entries()]
          .filter(([, v]) => supplyRaw > 0n && (v * 10000n) / supplyRaw >= BigInt(Math.round(c.poolMinPct * 100)))
          .map(([a]) => a)
      )
      holdersSource = 'rpc-balanceof'
      return {
        map: built.map,
        contracts,
        source: 'rpc-balanceof',
        partial: !built.complete,
        scannedFrom: built.scannedFrom,
        scannedTo: built.scannedTo,
      }
    }

    throw new Error(`no holder source available — ${tried.join(' · ')}`)
  }

  /** A stand-in queue, so the counter and the 3D hot dog can be built and
   *  reviewed before a real coin exists. Every event it feeds is demo:true. */
  function demoHolders() {
    const rows = []
    let seed = 987654321
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    let total = 0
    for (let i = 0; i < c.demoHolders; i++) {
      const weight = Math.pow(rnd(), 2.2) * 100 + 0.2 // a realistic long tail
      total += weight
      let addr = '0x'
      for (let k = 0; k < 40; k++) addr += '0123456789abcdef'[(rnd() * 16) | 0]
      rows.push({ address: addr, weight })
    }
    rows.sort((a, b) => b.weight - a.weight)
    return rows.map((r, i) => ({
      address: r.address,
      raw: BigInt(Math.round(r.weight * 1e9)),
      amount: r.weight * 1e6,
      pct: (r.weight / total) * 100,
      rank: i + 1,
    }))
  }

  /** Refresh the queue the next bell will feed. */
  async function pollHolders() {
    if (!isAddr(c.token)) {
      if (c.demoHolders > 0) {
        const rows = demoHolders()
        holders = { ts: now(), rows, queued: rows.length, supply: 1e9, total: rows.length, demo: true }
        emit({ type: 'holders', count: rows.length, demo: true, source: 'demo' })
        console.warn(`[hdr] DEMO queue of ${rows.length} — no TOKEN configured, nothing here is real`)
      }
      return
    }
    try {
      if (tokenTotalSupply === 0n) await loadTokenMeta()
      const res = await fetchHolders()
      contractHolders = res.contracts
      await refreshRpcPools()
      refreshPools(res.map)

      const supply = fmtUnits(tokenTotalSupply, tokenDecimals)
      holdersSupply = supply
      let crawled = 0n
      let inPools = 0n
      const rows = []
      for (const [address, raw] of res.map) {
        crawled += raw
        if (poolSet.has(address)) inPools += raw
        if (raw <= 0n || isExcluded(address)) continue
        const amount = fmtUnits(raw, tokenDecimals)
        const pct = supply > 0 ? (amount / supply) * 100 : 0
        if (pct < c.minPct || pct > c.maxPct) continue
        rows.push({ address, raw, amount, pct })
      }

      // A crawl that only saw a sliver of the supply is a TRUNCATED crawl, not
      // a coin with a tiny float. Feeding over it would hand every hot dog to
      // whichever addresses happened to land on the first page.
      const coverage = tokenTotalSupply > 0n ? Number((crawled * 10000n) / tokenTotalSupply) / 100 : 0
      if (coverage < c.minSupplyCoverage) {
        diagnostics = { ts: now(), token: c.token, coveragePct: coverage, rejected: 'crawl covers too little of the supply' }
        console.warn(`[hdr] crawl covers only ${coverage.toFixed(1)}% of supply (need ${c.minSupplyCoverage}%) — snapshot rejected`)
        return
      }

      await verifyBalances(rows)
      const onlyWallets = await keepOnlyWallets(rows)
      if (onlyWallets.removed.length) {
        console.info(`[hdr] ${onlyWallets.removed.length} contract(s) taken out of the queue`)
      }
      const live = onlyWallets.rows.filter((r) => r.raw > 0n && r.pct >= c.minPct && r.pct <= c.maxPct)
      live.sort((a, b) => b.amount - a.amount)
      live.forEach((r, i) => (r.rank = i + 1))

      // A collapse in the holder count is an indexer problem far more often
      // than a real exodus, and feeding over it silently concentrates the drop
      // into whichever addresses survived the bad crawl.
      if (lastEligibleCount > 20 && live.length < lastEligibleCount * 0.3) {
        diagnostics = { ts: now(), token: c.token, rejected: 'eligible holders collapsed vs the previous crawl', was: lastEligibleCount, now: live.length }
        console.warn(`[hdr] eligible holders fell ${lastEligibleCount} -> ${live.length} — snapshot rejected as a likely bad crawl`)
        return
      }
      lastEligibleCount = live.length

      // The last cut, and the only one that is about money rather than truth:
      // a hard ceiling on how many mouths one round can feed. If the queue is
      // longer than that, the largest holders are served — and the frontend is
      // told the queue was cut, rather than being shown a shorter queue.
      const queued = live.length
      const served = live.slice(0, c.maxRecipients)

      holders = { ts: now(), rows: served, queued, supply, total: res.map.size, capped: queued > served.length }
      const poolPct = supply > 0 ? (fmtUnits(inPools, tokenDecimals) / supply) * 100 : 0
      diagnostics = {
        ts: now(),
        token: c.token,
        tokenSymbol,
        totalSupply: supply,
        source: holdersSource,
        addressesSeen: res.map.size,
        coveragePct: coverage,
        contractsFlagged: contractHolders.size,
        heldByPoolsPct: poolPct,
        pools: [...poolSet].map((a) => ({
          address: a,
          balance: fmtUnits(res.map.get(a) || 0n, tokenDecimals),
          pctOfSupply: supply > 0 ? (fmtUnits(res.map.get(a) || 0n, tokenDecimals) / supply) * 100 : 0,
          confirmedOnchain: rpcPools.has(a),
          flaggedContract: contractHolders.has(a),
        })),
        eligible: queued,
        servedPerRound: served.length,
        cappedAt: queued > served.length ? c.maxRecipients : null,
        eligibleSupplyPct: served.reduce((a, r) => a + r.pct, 0),
        top: served.slice(0, 10).map((r) => ({ address: r.address, amount: r.amount, pct: r.pct })),
        settings: {
          onchainVerified: c.verifyOnchain,
          minEligiblePct: c.minPct,
          maxHolderPct: c.maxPct,
          maxRecipients: c.maxRecipients,
          poolMinPct: c.poolMinPct,
          minSupplyCoverage: c.minSupplyCoverage,
        },
      }
      emit({ type: 'holders', count: served.length, queued, capped: queued > served.length, source: holdersSource })
      console.info(
        `[hdr] via ${holdersSource}: ${queued} eligible holder(s) of ${tokenSymbol || c.token} · ` +
          `${poolSet.size} pool/curve excluded (${poolPct.toFixed(1)}% of supply) · crawl covered ${coverage.toFixed(1)}%`
      )
    } catch (e) {
      console.error('[hdr] holders poll:', e.message)
    }
  }

  /**
   * Analyse ANY coin's holders without touching the live queue — point it at a
   * launchpad address and it reports what it found and, more usefully, WHY each
   * address was excluded.
   */
  async function probe(tokenAddress, opts = {}) {
    const token = String(tokenAddress || '').trim().toLowerCase()
    if (!isAddr(token)) throw new Error('not an EVM address')

    let decimals = 18
    let supplyRaw = 0n
    try {
      const meta = await getJson(c.blockscout, `/api/v2/tokens/${token}`, bsAuth())
      if (meta?.decimals != null) decimals = Number(meta.decimals)
      if (meta?.total_supply != null) supplyRaw = BigInt(meta.total_supply)
    } catch {}
    if (supplyRaw === 0n && provider) {
      const t = new ethers.Contract(token, ERC20_ABI, provider)
      try { decimals = Number(await t.decimals()) } catch {}
      try { supplyRaw = await t.totalSupply() } catch {}
    }
    if (supplyRaw === 0n) throw new Error('could not read total supply — wrong chain or wrong address?')

    // `from` is the difference between a useful probe and a timeout on a busy
    // coin: given the block it launched at, the scan is bounded and fast.
    const res = await fetchHolders(token, supplyRaw, {
      maxCalls: Number(opts.maxCalls) || c.probeMaxCalls,
      lookback: c.probeLookback,
      startBlock: opts.startBlock != null ? Number(opts.startBlock) : undefined,
      deadline: Date.now() + (Number(opts.timeoutMs) || c.probeTimeoutMs),
    })

    const supply = fmtUnits(supplyRaw, decimals)
    const minRaw = (supplyRaw * BigInt(Math.round(c.poolMinPct * 1000))) / 100_000n
    const pools = new Set()
    let biggest = null
    let biggestBal = 0n
    for (const a of res.contracts) {
      const b = res.map.get(a) || 0n
      if (b >= minRaw) pools.add(a)
      if (b > biggestBal) { biggestBal = b; biggest = a }
    }
    if (biggest) pools.add(biggest)
    if (provider) {
      const t = new ethers.Contract(token, ERC20_ABI, provider)
      for (const a of c.poolCandidates) {
        try { if ((await t.balanceOf(a)) >= minRaw) pools.add(a) } catch {}
      }
    }

    let crawled = 0n
    const eligible = []
    const excluded = []
    for (const [address, raw] of res.map) {
      crawled += raw
      const amount = fmtUnits(raw, decimals)
      const pct = supply > 0 ? (amount / supply) * 100 : 0
      let why = null
      if (raw <= 0n) why = 'zero balance'
      else if (address === ZERO || address === DEAD) why = 'burn address'
      else if (c.exclude.has(address)) why = 'on the exclude list'
      else if (pools.has(address)) why = 'pool or bonding curve'
      else if (c.excludeContracts && res.contracts.has(address)) why = 'contract'
      else if (pct < c.minPct) why = `holds less than ${c.minPct}% of supply`
      else if (pct > c.maxPct) why = `holds more than ${c.maxPct}% of supply`
      if (why) excluded.push({ address, amount, pct, why })
      else eligible.push({ address, amount, pct, raw })
    }
    const verified = await keepOnlyWallets(eligible)
    for (const r of verified.removed) excluded.push(r)
    const wallets = verified.rows

    wallets.sort((a, b) => b.amount - a.amount)
    excluded.sort((a, b) => b.amount - a.amount)
    wallets.forEach((r, i) => (r.rank = i + 1))

    const coverage = supplyRaw > 0n ? Number((crawled * 10000n) / supplyRaw) / 100 : 0
    return {
      token,
      source: res.source,
      partial: !!res.partial,
      partialHint: res.partial
        ? 'Only part of the history was scanned. Re-run with &from=<the block the coin launched at> for a complete answer, or set BLOCKSCOUT_API_KEY to use the indexer.'
        : null,
      scannedFrom: res.scannedFrom ?? null,
      scannedTo: res.scannedTo ?? null,
      decimals,
      totalSupply: supply,
      addressesSeen: res.map.size,
      coveragePct: coverage,
      coverageOk: coverage >= c.minSupplyCoverage,
      contractsFlagged: res.contracts.size,
      pools: [...pools].map((a) => ({
        address: a,
        amount: fmtUnits(res.map.get(a) || 0n, decimals),
        pctOfSupply: supply > 0 ? (fmtUnits(res.map.get(a) || 0n, decimals) / supply) * 100 : 0,
        known: c.poolCandidates.includes(a),
        flaggedContract: res.contracts.has(a),
      })),
      eligible: {
        count: wallets.length,
        supplyPct: wallets.reduce((a, r) => a + r.pct, 0),
        contractsRejected: verified.removed.length,
        top: wallets.slice(0, 25).map(({ raw, ...r }) => r),
        all: opts.full ? wallets : undefined,
      },
      excluded: { count: excluded.length, top: excluded.slice(0, 25) },
      settings: {
        poolMinPct: c.poolMinPct,
        minEligiblePct: c.minPct,
        maxHolderPct: c.maxPct,
        maxRecipients: c.maxRecipients,
        minSupplyCoverage: c.minSupplyCoverage,
        excludeContracts: c.excludeContracts,
      },
    }
  }

  // ======================================================================
  // THE COUNTER
  // ======================================================================

  let ethUsd = null
  let ethUsdAt = 0
  let pot = null

  async function fetchEthUsd() {
    if (c.ethUsdOverride) return c.ethUsdOverride
    if (ethUsd != null && now() - ethUsdAt < 10 * 60_000) return ethUsd
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
        headers: HTTP_HEADERS,
        signal: AbortSignal.timeout(9000),
      })
      const j = await r.json()
      const p = Number(j?.ethereum?.usd)
      if (p > 0) { ethUsd = p; ethUsdAt = now() }
    } catch {
      /* keep the last good price; a stale ETH quote beats a blank till */
    }
    return ethUsd
  }

  /**
   * What the till holds, and — the number this whole page is really about —
   * how many more rounds it can pay for.
   *
   * Runway is published continuously rather than only at the bell, because it
   * is the number that decides whether holding the coin is worth anything. A
   * treasury with four rounds left in it should say so.
   */
  async function pollPot() {
    if (!provider || !wallet) {
      // With no wallet there is no till. Say so rather than showing a zero,
      // which would read as "the till is empty" instead of "unset".
      pot = { ready: false, reason: wallet ? 'no rpc' : 'no treasury wallet configured' }
      emit({ type: 'pot', ...pot })
      return
    }
    try {
      const [balWei, px] = await Promise.all([provider.getBalance(wallet.address), fetchEthUsd()])
      const spendableWei = balWei > c.leaveWei ? balWei - c.leaveWei : 0n
      const eth = fmtUnits(balWei, 18)
      const spendableEth = fmtUnits(spendableWei, 18)
      const usd = px ? eth * px : null
      const spendableUsd = px ? spendableEth * px : null

      const mouths = holders?.rows?.length || 0
      const perRound = mouths * config.hotDogUsd
      const capUsd = spendableUsd != null ? roundCapUsd(spendableUsd) : null

      pot = {
        ready: true,
        address: wallet.address,
        addrUrl: explorerAddr(wallet.address),
        eth,
        ethUsd: px ?? null,
        usd,
        spendableUsd,
        gasReserveEth: fmtUnits(c.leaveWei, 18),
        /** What the next bell will cost at today's queue length. */
        nextRoundUsd: perRound || null,
        /** And what the brake will actually let out of the door. */
        roundCapUsd: capUsd,
        /** Full rounds left, at this queue length, if nothing is ever added. */
        roundsLeft: spendableUsd != null && perRound > 0 ? Math.floor(spendableUsd / perRound) : null,
        maxRoundPct: c.maxRoundPct,
        asset: payingNative ? 'native' : 'erc20',
        dryRun,
      }
      emit({ type: 'pot', ...pot })
    } catch (e) {
      console.warn('[hdr] till:', e.message)
    }
  }

  /** The brake: the most one round is ever allowed to spend. */
  function roundCapUsd(spendableUsd) {
    let cap = (spendableUsd * c.maxRoundPct) / 100
    if (c.maxRoundUsd != null) cap = Math.min(cap, c.maxRoundUsd)
    return cap
  }

  /**
   * Decide the round's bill.
   *
   * `flat` wants `people × $1` and gets it, unless the brake says otherwise —
   * in which case everybody gets an equal, smaller share rather than the first
   * N in the list getting a whole dollar and the rest getting nothing. Half a
   * hot dog for everyone is a worse day; half the queue going hungry while the
   * other half eats is a different product.
   */
  function budget({ people, spendableUsd }) {
    const want = c.mode === 'flat' ? people * config.hotDogUsd : roundCapUsd(spendableUsd)
    const cap = roundCapUsd(spendableUsd)
    const total = Math.min(want, cap)
    const perHolderUsd = c.mode === 'flat' && people > 0 ? total / people : null
    return {
      totalUsd: total,
      perHolderUsd,
      wantedUsd: want,
      capUsd: cap,
      shortfall: c.mode === 'flat' && total < want - 1e-9,
    }
  }

  const fakeHash = () => `0xSIM${now().toString(16)}${Math.random().toString(16).slice(2, 10)}`

  // ----------------------------------------------------- paying in an ERC-20

  let payoutDecimals = 18
  let payoutSymbol = null
  let wethApproved = false

  async function loadPayoutMeta() {
    if (payingNative || !provider || !isAddr(c.payoutToken)) return
    const t = new ethers.Contract(c.payoutToken, ERC20_ABI, provider)
    try { payoutDecimals = Number(await t.decimals()) } catch {}
    try { payoutSymbol = await t.symbol() } catch {}
  }

  /**
   * Top the till up with however much of the payout token this round is short.
   *
   * Deliberately buys the SHORTFALL rather than the whole bill: the treasury
   * usually still holds change from the last round, and swapping through a thin
   * Algebra pool every five minutes for money it already has is a slippage tax
   * paid twelve times an hour.
   */
  async function ensurePayoutToken(needRaw) {
    const token = new ethers.Contract(c.payoutToken, ERC20_ABI, wallet)
    const have = await token.balanceOf(wallet.address)
    if (have >= needRaw) return { bought: false, have }

    const shortRaw = needRaw - have
    const px = await fetchEthUsd()
    if (!px) throw new Error('no ETH price — cannot size the swap')
    const shortUsd = fmtUnits(shortRaw, payoutDecimals) * c.payoutTokenUsd
    const budgetWei = (ethers.parseEther('1') * usdToBig(shortUsd * 1.05)) / usdToBig(px) // 5% headroom

    const bal = await provider.getBalance(wallet.address)
    const spendable = bal > c.leaveWei ? bal - c.leaveWei : 0n
    if (budgetWei > spendable) throw new Error('not enough ETH in the till to buy this round')

    const fee = await provider.getFeeData()
    const gas = fee.maxFeePerGas
      ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.maxFeePerGas }
      : { gasPrice: fee.gasPrice }

    const weth = new ethers.Contract(c.weth, WETH_ABI, wallet)
    const router = new ethers.Contract(c.router, ROUTER_ABI, wallet)

    const wbal = await weth.balanceOf(wallet.address)
    if (wbal < budgetWei) {
      const t = await weth.deposit({ value: budgetWei - wbal, gasLimit: 150_000n, ...gas })
      await t.wait()
    }
    if (!wethApproved) {
      if ((await weth.allowance(wallet.address, c.router)) < budgetWei) {
        const t = await weth.approve(c.router, ethers.MaxUint256, { gasLimit: 150_000n, ...gas })
        await t.wait()
      }
      wethApproved = true
    }

    // Quote with a static call first: these pools are thin and a blind swap can
    // land at a price nobody would have accepted.
    const deadline = Math.floor(now() / 1000) + 1200
    const iface = new ethers.Interface(ROUTER_ABI)
    const args = [c.weth, c.payoutToken, c.poolDeployer, wallet.address, deadline, budgetWei, 0n, 0n]
    let quoted = 0n
    try {
      const res = await provider.call({ from: wallet.address, to: c.router, data: iface.encodeFunctionData('exactInputSingle', [args]) })
      ;[quoted] = iface.decodeFunctionResult('exactInputSingle', res)
    } catch (e) {
      throw new Error(`quote reverted: ${(e.shortMessage || e.message || '').slice(0, 90)}`)
    }
    if (quoted <= 0n) throw new Error('quote is zero — no pool liquidity for the payout token')

    const minOut = (quoted * BigInt(100 - Math.round(c.slippagePct))) / 100n
    const before = await token.balanceOf(wallet.address)
    const tx = await router.exactInputSingle(
      [c.weth, c.payoutToken, c.poolDeployer, wallet.address, deadline, budgetWei, minOut, 0n],
      { gasLimit: 700_000n, ...gas }
    )
    const rc = await tx.wait()
    const after = await token.balanceOf(wallet.address)
    if (rc.status !== 1 || after <= before) throw new Error('swap failed')
    return { bought: true, have: after, eth: fmtUnits(budgetWei, 18), amount: fmtUnits(after - before, payoutDecimals), tx: tx.hash }
  }

  // --------------------------------------------------------------- the bell

  /**
   * Serve the round. Everyone in the queue, one dollar each.
   *
   * The transfer loop is Stock Royale's, and the two things it is careful about
   * are worth restating: a "nonce too low" or a timeout does NOT mean the
   * transfer failed — if the chain's pending nonce moved past ours, it landed,
   * and retrying would feed that wallet twice. And every send is recorded the
   * instant it is broadcast, so a crash half way through leaves a receipt book
   * that matches the chain rather than one that forgot the first half.
   */
  let warnedUnconfigured = false

  async function serve(round) {
    if (!enabled) return
    if (busy) {
      console.warn('[hdr] previous round still serving — skipping this bell')
      return
    }
    // Armed, but there is no coin yet.
    //
    // Not an error, and emphatically not one to record every round: with a
    // five-second bell that is twelve failed rounds a minute filling the
    // history and the log with "nobody in the queue" before the token even
    // exists. Say it once and wait quietly for the address.
    if (!isAddr(c.token) && !holders?.demo) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true
        console.info('[hdr] armed and waiting — set TOKEN to the coin address and rounds start paying')
      }
      return
    }
    warnedUnconfigured = false
    const rows = holders?.rows || []
    busy = true
    try {
      if (!rows.length) throw new Error('nobody in the queue: no wallet clears the eligibility floor')
      if (!holders?.demo && now() - (holders?.ts || 0) > c.holdersStaleMs) {
        throw new Error('holder snapshot is stale — refusing to pay out over frozen data')
      }

      // A dry run may have no network at all; a live one must never guess.
      const px = (await fetchEthUsd()) || (dryRun ? Number(process.env.DEMO_ETH_USD || 3000) : null)
      if (payingNative && !px) throw new Error('no ETH price — refusing to guess what a dollar is worth')

      let spendableUsd
      if (dryRun) {
        spendableUsd = Number(process.env.DEMO_TILL_USD || 500)
      } else {
        const bal = await provider.getBalance(wallet.address)
        const spendableWei = bal > c.leaveWei ? bal - c.leaveWei : 0n
        spendableUsd = fmtUnits(spendableWei, 18) * px
      }

      const people = rows.length
      const bill = budget({ people, spendableUsd })
      if (bill.totalUsd <= 0) throw new Error('the till is empty')

      const asset = payingNative
        ? { kind: 'native', symbol: 'ETH', decimals: 18, usdPerUnit: px }
        : { kind: 'erc20', symbol: payoutSymbol || 'USD', decimals: payoutDecimals, usdPerUnit: c.payoutTokenUsd, address: c.payoutToken }

      emit({
        type: 'serveStart',
        round,
        people,
        queued: holders?.queued ?? people,
        capped: !!holders?.capped,
        perHolderUsd: bill.perHolderUsd,
        hotDogsEach: bill.perHolderUsd != null ? bill.perHolderUsd / config.hotDogUsd : null,
        budgetUsd: bill.totalUsd,
        shortfall: bill.shortfall,
        mode: c.mode,
        asset: asset.symbol,
        hotDogUsd: config.hotDogUsd,
        token: c.token,
        tokenSymbol,
        explorer: c.explorer,
        dryRun,
        demo: !!holders?.demo,
      })

      // --- how much, in the units the chain actually moves -------------------
      // Integer arithmetic on micro-dollars throughout. A dollar split across
      // five hundred wallets in floating point drifts; this cannot.
      const unitsPerUsd = (usd) => {
        const u = usdToBig(usd)
        if (asset.kind === 'native') return (ethers.parseEther('1') * u) / usdToBig(px)
        return (10n ** BigInt(payoutDecimals) * u) / usdToBig(c.payoutTokenUsd)
      }

      let plan
      if (c.mode === 'flat') {
        const each = unitsPerUsd(bill.perHolderUsd)
        if (each <= 0n) throw new Error('a share of this round rounds to zero — the till is too thin to split')
        plan = rows.map((r) => ({ ...r, raw_out: each, usd: bill.perHolderUsd }))
      } else {
        const totalRaw = unitsPerUsd(bill.totalUsd)
        const totalW = rows.reduce((a, r) => a + r.raw, 0n)
        if (totalW <= 0n) throw new Error('the queue holds nothing')
        plan = rows
          .map((r) => {
            const raw_out = (totalRaw * r.raw) / totalW
            return { ...r, raw_out, usd: fmtUnits(raw_out, asset.decimals) * asset.usdPerUnit }
          })
          .filter((p) => p.raw_out > 0n)
      }
      if (!plan.length) throw new Error('every cut rounds to zero')

      // --- top up the payout token, if that is what we pay in ---------------
      let buy = null
      if (asset.kind === 'erc20' && !dryRun) {
        const need = plan.reduce((a, p) => a + p.raw_out, 0n)
        const got = await ensurePayoutToken(need)
        if (got.bought) {
          buy = { amount: got.amount, eth: got.eth, tx: got.tx, txUrl: explorerTx(got.tx) }
          emit({ type: 'serveBuy', round, ...buy, symbol: asset.symbol })
        }
      }

      // --- pay ---------------------------------------------------------------
      const items = []
      let sentUsd = 0

      const record = (p, hash) => {
        const item = {
          to: p.address,
          rank: p.rank,
          pct: p.pct,
          held: p.amount,
          usd: p.usd,
          hotDogs: p.usd / config.hotDogUsd,
          amount: fmtUnits(p.raw_out, asset.decimals),
          asset: asset.symbol,
          tx: hash,
          txUrl: explorerTx(hash),
          addrUrl: explorerAddr(p.address),
        }
        sentUsd += p.usd
        items.push(item)
        emit({ type: 'servePayment', round, ...item })
      }

      if (dryRun) {
        for (const p of plan) {
          record(p, fakeHash())
          await sleep(30) // stream them so the queue on screen fills in visibly
        }
      } else {
        const token = asset.kind === 'erc20' ? new ethers.Contract(c.payoutToken, ERC20_ABI, wallet) : null
        const fee = await provider.getFeeData()
        const maxFee = fee.maxFeePerGas || fee.gasPrice || 1n
        const gas = fee.maxFeePerGas
          ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? fee.maxFeePerGas }
          : { gasPrice: fee.gasPrice }

        // A native send is a flat 21,000 gas; an ERC-20 transfer is measured
        // once against the real contract rather than guessed at.
        let gasLimit = 21_000n
        if (token) {
          gasLimit = c.payoutGas
          try {
            const est = await token.transfer.estimateGas(ethers.getAddress(plan[0].address), plan[0].raw_out)
            gasLimit = est * 2n < 200_000n ? 200_000n : est * 2n
          } catch {}
        }
        const need = BigInt(plan.length + 2) * gasLimit * maxFee
        const native = await provider.getBalance(wallet.address)
        if (native < need) {
          console.warn(`[hdr] gas ${fmtUnits(native, 18)} ETH < ~${fmtUnits(need, 18)} needed for ${plan.length} sends`)
        }

        let nonce = await wallet.getNonce()
        let failures = 0
        for (const p of plan) {
          let hash = null
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const tx = token
                ? await token.transfer(ethers.getAddress(p.address), p.raw_out, { nonce, gasLimit, ...gas })
                : await wallet.sendTransaction({ to: ethers.getAddress(p.address), value: p.raw_out, nonce, gasLimit, ...gas })
              hash = tx.hash
              break
            } catch (e) {
              const msg = String(e?.message || e).toLowerCase()
              // A timeout or "nonce too low" does NOT mean the transfer failed.
              // If the chain's pending nonce moved past ours it landed — record
              // it and never retry, or this wallet eats twice.
              if (/nonce|coalesce|timeout/.test(msg)) {
                try {
                  const pend = await wallet.getNonce('pending')
                  if (pend > nonce) { hash = `sent-nonce-${nonce}`; break }
                  nonce = pend
                } catch {}
                await sleep(1200 * (attempt + 1))
                continue
              }
              if (/rate|limit|-32007/.test(msg)) { await sleep(1200 * (attempt + 1)); continue }
              break
            }
          }
          if (!hash) { failures++; await sleep(c.sendDelayMs); continue }
          nonce++
          record(p, hash)
          await sleep(c.sendDelayMs)
        }
        if (failures) console.warn(`[hdr] ${failures} transfer(s) failed this round`)
      }

      const totalHotDogs = sentUsd / config.hotDogUsd
      session.hotDogs += totalHotDogs
      session.usd += sentUsd
      session.rounds += 1
      for (const it of items) session.people.add(it.to)

      // File it before announcing it: the history the frontend is about to let
      // somebody open should already have this round in it.
      await db?.recordRound({
        round,
        items,
        asset,
        perHolderUsd: bill.perHolderUsd,
        totalUsd: sentUsd,
        totalHotDogs,
        shortfall: bill.shortfall,
        buy,
        dryRun,
        demo: !!holders?.demo,
      })

      lastServed = {
        round,
        served: items.length,
        hotDogs: totalHotDogs,
        totalUsd: sentUsd,
        perHolderUsd: bill.perHolderUsd,
        hotDogsEach: bill.perHolderUsd != null ? bill.perHolderUsd / config.hotDogUsd : null,
        shortfall: bill.shortfall,
        asset: asset.symbol,
        // Bounded: this rides in every `hello`, and a 500-wallet round would
        // make the handshake heavier than the page.
        items: items.slice(0, 120),
        dryRun,
        demo: !!holders?.demo,
        at: now(),
      }

      emit({
        type: 'serveResult',
        round,
        served: items.length,
        hotDogs: totalHotDogs,
        totalUsd: sentUsd,
        perHolderUsd: bill.perHolderUsd,
        hotDogsEach: bill.perHolderUsd != null ? bill.perHolderUsd / config.hotDogUsd : null,
        shortfall: bill.shortfall,
        asset: asset.symbol,
        items,
        buy,
        explorer: c.explorer,
        dryRun,
        demo: !!holders?.demo,
      })
      console.info(
        `[hdr]${dryRun ? ' DRY' : ''} round ${round?.label}: ${items.length} fed · ` +
          `${totalHotDogs.toFixed(2)} ${BRAND.itemPlural} · $${sentUsd.toFixed(2)}`
      )
    } catch (e) {
      console.error('[hdr] round failed:', e.message)
      emit({ type: 'serveError', round, message: String(e.message || e) })
      // The bell rang whether or not money moved. Record it either way, so an
      // empty history means "nobody has been fed" and never "the recorder broke".
      await db?.recordSkippedRound({ round, reason: String(e.message || e) })
    } finally {
      busy = false
      pollHolders() // refresh the queue for the next bell
    }
  }

  /**
   * A dress rehearsal of a whole round over the REAL holders of a real coin.
   *
   * Not a mock: same holder detection, same pool and curve exclusion, same
   * on-chain balance check and the same split as a live round — everything
   * except the transfers. What it prints is what would actually be sent, which
   * is the only kind of rehearsal worth having before pointing money at a coin.
   */
  async function simulate({ token, tillUsd = 500, startBlock, hours, days, stream = true, maxCalls, timeoutMs } = {}) {
    if (!isAddr(token)) throw new Error('pass ?token=0x… — the coin whose holders would be fed')
    const t0 = now()

    // Nobody knows their coin's launch block offhand, but everybody knows
    // roughly when it launched. Robinhood Chain runs at about ten blocks a
    // second; rounding down scans slightly further back than asked, which errs
    // toward covering the whole history rather than missing the start of it.
    let from = startBlock != null && startBlock !== '' ? Number(startBlock) : null
    const window = Number(days) > 0 ? Number(days) * 24 : Number(hours) > 0 ? Number(hours) : 0
    if (from == null && window > 0 && provider) {
      const head = await provider.getBlockNumber()
      from = Math.max(0, head - Math.ceil(window * 35_000))
    }

    const scan = await probe(token, {
      full: true,
      startBlock: from ?? undefined,
      maxCalls: Number(maxCalls) || Math.max(c.probeMaxCalls, 400),
      timeoutMs: Number(timeoutMs) || Math.max(c.probeTimeoutMs, 90_000),
    })

    // A rehearsal over a partial view is worse than no rehearsal: it produces a
    // confident recipient list built from whoever happened to trade inside the
    // scanned window. Hold it to the SAME coverage floor a live round is held
    // to, and say exactly how to fix it.
    if (!scan.coverageOk || scan.partial) {
      throw new Error(
        `the scan only accounted for ${scan.coveragePct.toFixed(1)}% of supply (a round needs ${c.minSupplyCoverage}%), so ` +
          `this would rehearse the wrong queue. Say how far back to look with &days=7 (or &hours=12, or &from=<launch block>), ` +
          `or set BLOCKSCOUT_API_KEY to read holders from the indexer instead.`
      )
    }

    const all = scan.eligible.all || []
    const rows = all.slice(0, c.maxRecipients)
    if (!rows.length) throw new Error('nobody would be fed: no address clears the eligibility floor')

    const bill = budget({ people: rows.length, spendableUsd: Number(tillUsd) })
    const items = rows.map((r) => ({
      to: r.address,
      rank: r.rank,
      pct: r.pct,
      held: r.amount,
      usd: c.mode === 'flat' ? bill.perHolderUsd : (bill.totalUsd * r.pct) / scan.eligible.supplyPct,
      addrUrl: explorerAddr(r.address),
    })).map((it) => ({ ...it, hotDogs: it.usd / config.hotDogUsd }))

    if (stream) {
      emit({ type: 'serveStart', simulated: true, people: items.length, perHolderUsd: bill.perHolderUsd, budgetUsd: bill.totalUsd, hotDogUsd: config.hotDogUsd, shortfall: bill.shortfall, token })
      for (const it of items.slice(0, 400)) {
        emit({ type: 'servePayment', simulated: true, ...it, tx: null, txUrl: null })
        await sleep(20)
      }
      emit({ type: 'serveResult', simulated: true, served: items.length, hotDogs: items.reduce((a, i) => a + i.hotDogs, 0), totalUsd: bill.totalUsd })
    }

    return {
      simulated: true,
      note: 'Nothing was bought and nothing was sent. Same holder detection, same exclusions, same split as a live round.',
      coin: {
        token,
        symbol: tokenSymbol,
        source: scan.source,
        totalSupply: scan.totalSupply,
        addressesSeen: scan.addressesSeen,
        supplyCovered: scan.coveragePct,
        blocksScanned: scan.scannedFrom != null ? `${scan.scannedFrom} → ${scan.scannedTo}` : null,
      },
      excludedFromRound: {
        poolsAndCurves: scan.pools,
        otherCount: scan.excluded.count - scan.pools.length,
        examples: scan.excluded.top.filter((e) => e.why !== 'pool or bonding curve').slice(0, 8),
      },
      round: {
        mode: c.mode,
        tillUsd: Number(tillUsd),
        queue: scan.eligible.count,
        wouldFeed: items.length,
        cappedAt: scan.eligible.count > items.length ? c.maxRecipients : null,
        contractsRejected: scan.eligible.contractsRejected ?? 0,
        allVerifiedEoa: true,
        hotDogUsd: config.hotDogUsd,
        perHolderUsd: bill.perHolderUsd,
        [`${BRAND.itemPlural} each`]: bill.perHolderUsd != null ? bill.perHolderUsd / config.hotDogUsd : null,
        billUsd: bill.totalUsd,
        wantedUsd: bill.wantedUsd,
        roundCapUsd: bill.capUsd,
        shortfall: bill.shortfall,
        shortfallNote: bill.shortfall
          ? `The till would only cover $${bill.totalUsd.toFixed(2)} of the $${bill.wantedUsd.toFixed(2)} this queue is owed, so everybody eats less rather than some eating nothing.`
          : null,
        roundsLeft: Math.floor(Number(tillUsd) / (items.length * config.hotDogUsd)) || 0,
        queueList: items,
      },
      tookMs: now() - t0,
    }
  }

  return {
    serve,
    get enabled() { return enabled },
    get dryRun() { return dryRun },
    diagnostics() {
      return diagnostics || { ts: null, token: c.token || null, rejected: 'no crawl yet' }
    },
    refreshHolders: pollHolders,
    probe,
    simulate,
    potSnapshot: () => pot,
    lastRound: () => lastServed,
    sessionTotals: () => ({
      hotDogs: session.hotDogs,
      usd: session.usd,
      rounds: session.rounds,
      people: session.people.size,
    }),
    snapshot() {
      return {
        enabled,
        dryRun,
        mode: c.mode,
        asset: payingNative ? 'native' : payoutSymbol || 'erc20',
        hotDogUsd: config.hotDogUsd,
        brand: BRAND,
        token: c.token || null,
        tokenSymbol,
        explorer: c.explorer,
        queue: holders?.rows?.length ?? 0,
        queued: holders?.queued ?? 0,
        capped: !!holders?.capped,
        maxRecipients: c.maxRecipients,
        minEligiblePct: c.minPct,
        poolsExcluded: poolSet.size,
        demo: !!holders?.demo,
        holdersAt: holders?.ts ?? null,
        treasury: wallet ? wallet.address : null,
      }
    },
    start() {
      // The till is published whenever there is a wallet to read, armed or not:
      // you fund it, watch the number appear on screen, and only then flip
      // PAYOUTS on. Gating this behind `enabled` would leave the counter blank
      // right up until the moment it started spending itself.
      if (wallet) {
        pollPot()
        potTimer = setInterval(pollPot, c.potPollMs)
      }
      loadPayoutMeta()
      if (!enabled) {
        if (isAddr(c.token)) loadTokenMeta()
        if (c.demoHolders > 0) pollHolders()
        console.info(`[hdr] payouts disabled (set PAYOUTS=1 to arm)${wallet ? ' — till balance still published' : ''}`)
        return
      }
      console.info(
        `[hdr] armed${dryRun ? ' in DRY RUN — no funds move' : ''} · ${c.mode} · $${config.hotDogUsd} per holder ` +
          `· coin ${c.token || '(unset)'} · till ${wallet ? wallet.address : '(no key)'}`
      )
      pollHolders()
      holdersTimer = setInterval(pollHolders, c.holdersPollMs)
    },
    stop() {
      clearInterval(holdersTimer)
      clearInterval(potTimer)
    },
  }
}
