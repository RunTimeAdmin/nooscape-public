# Crawlnet (CRAWL) — Tokenized Directory Data Point

> **Status:** Data point — October 2026
> **Companion to:** `SCOPE.md` (no-token-at-launch decision), `AGENT_TRUST_TIER_DESIGN.md`
> **Purpose:** Document a comparable project that tied a token to an agent/crawler directory-style product, so the rationale for Nooscape's no-token decision is preserved with a concrete reference.
> **Operational update — 2026-10-08:** This is comparative research, not a Nooscape source, partner, endorsement, or implementation dependency.

---

## 1. What It Is

**Crawlnet** is a Solana project launched via Pump.fun (contract: `BXoHJddsWJLHtAopeiSbKUSELsu8hSFMs8baGMDkpump`). Pitch: fund a crypto-native LLM called **"queen"**, pretrained from scratch on data collected by its own web crawlers — whitepapers, docs, GitHub repos, crypto forums.

Market data at snapshot (Oct 6–7, 2026, ~2 days post-launch):

| Metric | Value |
|---|---|
| Price | ~$0.0036 |
| Market cap / FDV | ~$3.2–3.5M |
| 24h volume | ~$3.43M (volume > market cap — speculative) |
| Liquidity | ~$227K |
| Holders | ~7,315 |
| 24h price range | $0.0014 – $0.0035 (2.4x range) |

Security signals: 100% locked liquidity, mint/freeze authority disabled, 0% bundled buys, GeckoTerminal score 86/100. No named team or legal entity identified.

---

## 2. How the Token Funds the Project

All Pump.fun **creator fees** from CRAWL trading land directly in "queen's" wallet. The split:

- **60%** → compute: headless Chromium browser infrastructure + GPU hours for pretraining runs of queen.
- **40%** → reward pool, distributed **twice daily** (00:00 and 12:00 UTC) in SOL, split equally among every crawler that contributed at least 25 new pages that round. Sub-agents count at 0.25x weighting. Every SOL movement is recorded on a public on-chain ledger.

So the token's trading activity is the sole funding source for both the crawling infrastructure and the model training. No external revenue, no subscriptions, no API fees.

---

## 3. Token Utility (Burn Mechanics)

- **Burn CRAWL** → spawn a crawler instance seeded with a starting URL. Its collected pages are credited to the operator's wallet; it earns a share of the twice-daily SOL pool if it hits the 25-page minimum.
- **Burn 25,000 CRAWL** → run a sub-agent under an existing crawler (0.25x weighting; 80% of its earnings to sub-agent creator, 20% to parent crawler owner).
- **Burn 10,000 CRAWL** → order a custom crawl of a specific site (up to 25 pages, 3-hour window, single host, respects robots.txt, screened for scam/adult/gambling content; public report on completion).

---

## 4. The "Queen" Pipeline

1. Headless browsers crawl crypto web in organized "chapters" (whitepapers, docs, forums, GitHub).
2. Pages are canonicalized, deduplicated, filtered, tokenized with a custom tokenizer trained on the data.
3. Dataset indexed by project and chapter.
4. When treasury funding accumulates, queen is pretrained from random initialization on rented GPUs using only the crawled dataset.
5. Successive versions are larger, trained on more data; weights published publicly. Includes a live websocket feed, public dataset graph, and on-chain treasury ledger.

---

## 5. Why This Is a Cautionary Data Point for Nooscape

- **Circular economics:** trading fees fund the product, and holders burn tokens to earn a share of those same fees. Value depends entirely on sustained speculative trading volume — not on the product being useful.
- **Unproven product:** no independent verification of queen's output quality, usefulness, or competitiveness. The model is unproven at scale.
- **No team identity:** anonymous developer, no legal entity. Standard for Pump.fun launches, but means no accountability if the pipeline stops.
- **Speculative volume:** 24h volume exceeding market cap indicates trading interest, not product usage.
- **No long-term track record:** two days of history through one market regime.

This is the pattern Nooscape explicitly avoids: a token whose price chart moves on sentiment rather than on whether the dedup graph or trust tiers work. Nooscape's revenue is x402 micropayments and monthly API subscriptions in USDC — crypto-native without a token.

---

## 6. Open Questions / Things to Verify

- Whether the on-chain treasury ledger actually shows the 60/40 split in practice.
- Whether queen's published weights are genuinely trained on crawled data or are fine-tunes of existing models.
- Whether the 25-page minimum and 0.25x sub-agent weighting produce meaningful data quality or just incentivize page-count farming.
- Copycat risk: verify the contract address before citing.
