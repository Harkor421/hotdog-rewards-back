// ============================================================================
// config.js — every tunable in one place.
//
// Hotdog Rewards pays a hot dog. A hot dog is $1.50. Every round, every wallet
// holding $HDR gets one.
//
// The machinery underneath is Stock Royale's, unchanged where it matters:
// the same holder detection, the same pool / bonding-curve exclusion, the same
// on-chain balance verification and the same refusal guards. What changed is
// WHAT gets handed out — there it was a share of the winning stock, split
// pro-rata; here it is a flat dollar, the same dollar for everybody, because
// a hot dog costs the same whether you hold a million coins or a thousand.
// ============================================================================

import 'dotenv/config'

const num = (v, d) => (v === undefined || v === '' ? d : Number(v))
const bool = (v, d) => (v === undefined || v === '' ? d : String(v) === 'true' || String(v) === '1')

export const config = {
  port: num(process.env.PORT, 8080),
  /** Round length in ms. Rounds are aligned to the wall clock (…:00, :05, :10). */
  roundMs: num(process.env.ROUND_MS, 5 * 60 * 1000),
  /** Rounds kept in memory for the ticker on screen. */
  historyLen: num(process.env.HISTORY_LEN, 48),

  /**
   * THE HOT DOG.
   *
   * $1.50 is what one costs at the counter, so $1.50 is what a holder gets.
   * Change it here and every figure on the frontend follows: the headline, the
   * per-round split, the runway and the totals are all derived from this, and
   * the page is told the price rather than hard-coding it.
   */
  hotDogUsd: num(process.env.HOTDOG_USD, 1.5),

  chain: {
    /** Nothing pays until this is 1. */
    live: process.env.PAYOUTS === '1',
    /** And even then, nothing MOVES until this is explicitly false. */
    dryRun: bool(process.env.DRY_RUN, true),

    rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    chainId: num(process.env.CHAIN_ID, 4663),

    /**
     * The Pro API host, NOT the public explorer. The public instance
     * (robinhoodchain.blockscout.com) sits behind a Cloudflare challenge and
     * answers a server 403 with an HTML "Just a moment…" page — which reads
     * downstream as "this token has no holders". This host answers 402 without
     * a key, which at least says what is wrong.
     */
    blockscout: (process.env.BLOCKSCOUT_URL || 'https://api.blockscout.com/4663').replace(/\/$/, ''),
    blockscoutPublic: (process.env.BLOCKSCOUT_PUBLIC || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
    blockscoutKey: process.env.BLOCKSCOUT_API_KEY || '',
    explorer: (process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),

    /** $HDR itself — the coin you have to hold to be fed. */
    token: (process.env.TOKEN || '').trim().toLowerCase(),
    /** The treasury. Holds the money, pays the gas. NEVER commit a real key. */
    privateKey: process.env.DISTRIBUTOR_PRIVATE_KEY || '',

    /**
     * ---- WHAT A DOLLAR IS MADE OF ----
     *
     * `native`  send $1 worth of the chain's native coin (ETH). Needs no pool,
     *           no swap and no stablecoin to exist — the ETH/USD price turns a
     *           dollar into wei. This is the default because it works on day
     *           one, on any EVM chain, with nothing deployed.
     *
     * `erc20`   pay in a USD-pegged ERC-20 (`PAYOUT_TOKEN`). The treasury buys
     *           it with ETH through the same Algebra router Stock Royale buys
     *           stock with, then transfers it out. Use this when the chain has
     *           a stablecoin with real liquidity — a dollar that says "1.00" in
     *           the recipient's wallet reads better than 0.00023 ETH.
     */
    payoutAsset: (process.env.PAYOUT_ASSET || 'native').toLowerCase(),
    payoutToken: (process.env.PAYOUT_TOKEN || '').trim().toLowerCase(),
    /** What one unit of PAYOUT_TOKEN is worth in USD. A stablecoin is 1. */
    payoutTokenUsd: num(process.env.PAYOUT_TOKEN_USD, 1),

    weth: (process.env.WETH || '0x0bd7d308f8e1639fab988df18a8011f41eacad73').toLowerCase(),
    router: (process.env.SWAP_ROUTER || '0xCb0615a1478838DeA20E57447309be97f45DcA0f').toLowerCase(),
    poolDeployer: process.env.POOL_DEPLOYER || '0x0000000000000000000000000000000000000000',
    slippagePct: num(process.env.BUY_SLIPPAGE_PCT, 20), // thin Algebra pools

    /**
     * ---- HOW MUCH LEAVES PER ROUND ----
     *
     * `flat`     everyone gets HOTDOG_USD. This is the promise on the tin.
     * `prorata`  the round's budget split by holdings, exactly as Stock Royale
     *            splits a stock. Kept because it is the sybil-proof shape, and
     *            because some day the treasury may prefer it.
     */
    mode: (process.env.PAYOUT_MODE || 'flat').toLowerCase(),

    /**
     * The brake. A round never spends more than this share of the treasury,
     * whatever the holder count says it owes.
     *
     * Without it, one round can empty the pot: the treasury does not choose how
     * many holders exist, and a coin that doubles its holders overnight would
     * double the bill with no warning. At 4% a round the treasury survives
     * ~25 rounds even if it never earns another cent, and the frontend can
     * publish that runway honestly instead of promising a dollar it cannot pay.
     */
    maxRoundPct: num(process.env.MAX_ROUND_PCT, 4),
    /** Hard ceiling in dollars per round, if you'd rather cap it absolutely. */
    maxRoundUsd: process.env.MAX_ROUND_USD ? Number(process.env.MAX_ROUND_USD) : null,
    /** Native coin held back for gas — never spent on hot dogs. */
    leaveWei: BigInt(Math.round(num(process.env.LEAVE_ETH, 0.002) * 1e18)),
    /** Override the ETH price instead of asking CoinGecko (mostly for testing). */
    ethUsdOverride: process.env.ETH_USD ? Number(process.env.ETH_USD) : null,
    potPollMs: num(process.env.POT_POLL_MS, 45_000),

    /**
     * ---- THE SYBIL FLOOR ----
     *
     * This is the number that matters most in `flat` mode, and it did not
     * matter at all in Stock Royale.
     *
     * A pro-rata split is self-defending: splitting a bag across a hundred
     * wallets gets you exactly the same slice you had before, so nobody
     * bothers. A FLAT dollar per wallet is the opposite — a hundred wallets is
     * a hundred dollars — so the only thing standing between this treasury and
     * a wallet generator is a floor on how much of the supply you have to hold
     * to be a mouth worth feeding.
     *
     * MIN_ELIGIBLE_PCT is that floor, and it is also a cap on the bill: at
     * 0.1%, at most 1,000 wallets can ever qualify, so a round costs at most
     * 1,000 hot dogs no matter what happens. Raise it to make the coin harder
     * to farm, lower it to feed more people. Do not set it to zero.
     */
    minPct: num(process.env.MIN_ELIGIBLE_PCT, 0.1),
    /** Whales are people too, but a wallet this large is usually the team. */
    maxPct: num(process.env.MAX_HOLDER_PCT, 50),
    /** Belt and braces: never pay more than this many wallets in one round. */
    maxRecipients: num(process.env.MAX_RECIPIENTS, 500),
    excludeContracts: bool(process.env.EXCLUDE_CONTRACTS, true),

    /**
     * ---- POOL / CURVE DETECTION ----
     * On a launchpad token the BONDING CURVE holds most of the supply, and
     * after graduation the AMM pool does. Neither is a person. Miss one and it
     * eats the biggest hot dog every five minutes forever.
     *
     * Any CONTRACT holding at least poolMinPct of supply is treated as a pool —
     * the only rule that survives a launchpad shipping a v2, because it needs
     * no prior knowledge of any address.
     */
    poolMinPct: num(process.env.POOL_MIN_PCT, 0.5),
    /**
     * Known infrastructure, re-checked straight off the chain so detection does
     * not depend on the indexer being up. The first is Robinhood Chain's
     * Uniswap v4 singleton PoolManager — ALL v4 liquidity for every token lives
     * in that one contract, so it shows up as a single enormous "holder".
     */
    poolCandidates: (
      process.env.POOL_CANDIDATES ||
      '0x8366a39cc670b4001a1121b8f6a443a643e40951,0x52d571fe77027298e06e52fc4434e1507f819268'
    ).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),

    /**
     * Re-read every eligible holder's balance from the chain before paying.
     * The indexer decides WHO is in the list; the chain decides HOW MUCH.
     */
    verifyOnchain: bool(process.env.VERIFY_ONCHAIN, true),
    verifyMax: num(process.env.VERIFY_MAX, 400),

    /** Rebuild holders from Transfer logs when no indexer will answer. */
    chainFallback: bool(process.env.CHAIN_FALLBACK, true),
    chainStartBlock: process.env.TOKEN_START_BLOCK ? Number(process.env.TOKEN_START_BLOCK) : null,
    chainMaxCalls: num(process.env.CHAIN_MAX_CALLS, 400),
    probeMaxCalls: num(process.env.PROBE_MAX_CALLS, 150),
    probeLookback: num(process.env.PROBE_LOOKBACK, 400_000),
    probeTimeoutMs: num(process.env.PROBE_TIMEOUT_MS, 45_000),

    /** Refuse to pay if the crawl accounts for less than this % of supply. */
    minSupplyCoverage: num(process.env.MIN_SUPPLY_COVERAGE, 40),
    /**
     * How much of the supply must be ACCOUNTED FOR before the holder search is
     * allowed to stop. Unaccounted supply is not noise — it is wallets nobody
     * has looked at yet, and in flat mode every one of them is a person who
     * goes hungry. Stopping at 83% once hid the holder owed 89% of an airdrop.
     */
    discoveryTarget: num(process.env.DISCOVERY_TARGET, 99.5),

    exclude: new Set(
      (process.env.EXCLUDE_ADDRESSES || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    ),
    payoutGas: BigInt(process.env.PAYOUT_GAS_LIMIT || 250_000),
    sendDelayMs: num(process.env.SEND_DELAY_MS, 250),
    holdersPollMs: num(process.env.HOLDERS_POLL_MS, 60_000),
    holdersStaleMs: num(process.env.HOLDERS_STALE_MS, 10 * 60_000),

    /**
     * Dev only: synthesize this many holders so the counter, the queue and the
     * 3D hot dog can be built and reviewed before a real coin exists. Every
     * event it produces is stamped demo:true and the frontend labels it — it
     * must never be mistaken for a payout that happened.
     */
    demoHolders: num(process.env.DEMO_HOLDERS, 0),
  },

  /** Durable store for every hot dog ever served. Optional; it runs without one. */
  mongoUrl:
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_PUBLIC_URL ||
    process.env.DATABASE_URL ||
    '',
}

/**
 * The brand, as the frontend should render it.
 *
 * `name` and `coin` are deliberately separate: the product is Hotdog Rewards
 * and the ticker is $HDR, and a page that says "holding $Hotdog Rewards"
 * because someone collapsed the two is the kind of thing nobody notices until
 * it is on screen. The on-chain symbol is read from the contract and wins over
 * `coin` once a token is configured.
 */
export const BRAND = Object.freeze({
  name: process.env.SITE_NAME || 'Hotdog Rewards',
  coin: process.env.COIN_NAME || 'HDR',
  item: process.env.ITEM_NAME || 'hot dog',
  itemPlural: process.env.ITEM_PLURAL || 'hot dogs',
})

if (config.chain.mode !== 'flat' && config.chain.mode !== 'prorata') {
  console.error(`[config] PAYOUT_MODE must be "flat" or "prorata", got "${config.chain.mode}"`)
  process.exit(1)
}
if (config.chain.payoutAsset !== 'native' && config.chain.payoutAsset !== 'erc20') {
  console.error(`[config] PAYOUT_ASSET must be "native" or "erc20", got "${config.chain.payoutAsset}"`)
  process.exit(1)
}
if (config.chain.payoutAsset === 'erc20' && !config.chain.payoutToken) {
  console.error('[config] PAYOUT_ASSET=erc20 needs PAYOUT_TOKEN=0x… (the dollar you pay in)')
  process.exit(1)
}
if (config.chain.mode === 'flat' && config.chain.minPct <= 0) {
  console.error(
    '[config] MIN_ELIGIBLE_PCT must be > 0 in flat mode.\n' +
      '         A flat dollar per wallet with no floor is a wallet generator pointed at your treasury.\n' +
      '         See config.js > THE SYBIL FLOOR.'
  )
  process.exit(1)
}
