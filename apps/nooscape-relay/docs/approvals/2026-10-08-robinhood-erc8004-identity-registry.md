# Source approval — Robinhood Chain ERC-8004 identity registry

**Reviewed:** 2026-10-08
**Source key:** `robinhood-erc8004-identity-registry`
**Protocol:** `erc8004`
**Canonical endpoint:** `https://rpc.mainnet.chain.robinhood.com` (JSON-RPC `POST`, read-only methods only)
**Allowed hostname:** `rpc.mainnet.chain.robinhood.com`
**Registry contract:** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (chain id 4663)

## Approval scope

Approve a **bounded, read-only on-chain window read**: `eth_chainId`, `eth_blockNumber`, and exactly one `eth_getLogs` call filtered to the registry's `Registered` topic over the trailing 2,000,000-block window ending 256 blocks behind the head. The newest 24 events are accepted per run; the scan fails closed above 256 events. Three RPC requests per manual run, `manual_only` execution policy; the scheduled worker rejects this protocol.

The adapter must not call per-agent methods (`ownerOf`, `tokenURI`), dereference any agent URI (https, IPFS, or otherwise), access a wallet, sign, or submit a transaction. The QuickNode REST explorer and every x402-paywalled surface remain out of scope; this route uses the public RPC endpoint only.

## Verified boundary facts (2026-10-08)

| Fact | Observation |
|---|---|
| Chain | `eth_chainId` → `0x1237` (4663); head at validation 83,762,727 |
| Registry | ERC1967 proxy, verified on the chain's Blockscout, token name `AgentIdentity`, symbol `AGENT` |
| Event | `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`, topic0 `0xca52e62c…bc4a`; `MetadataSet`, `URIUpdated`, and ERC-721 `Transfer` also observed |
| Window behavior | 2,000,000 trailing blocks → 63 `Registered` events (agent ids 8575–8637, strictly sequential); 250,000 → 2; 100,000 → 0 |
| Newest registration at validation | Agent `8637`, block 83,571,770 (2026-10-08 ~19:48 UTC), empty URI |
| Current-state reads | `ownerOf(1)` = `0x2b5b…9da3`, `tokenURI(1)` = `https://a-identity.xyz/.well-known/agent-card.json` (operator `cast` confirmation, reproduced from a second host); `ownerOf(8637)`/`ownerOf(8638)` currently revert — registration events are the durable evidence and current token state is deliberately not queried by the adapter |
| Observed URI classes | `https://` web links (ripples.run, olas.network, agnt.social, alpharc.app, musegod.org, …), `ipfs://` references (CIDv0 and CIDv1), inline `data:application/json` (base64 and URL-encoded — e.g. `{"name":"Gand OS Funding"}`), and empty |
| Count reconciliation lead | Max sequential agent id 8637 ⇒ registry total ≈ 8,637, versus agenteconomy's 14,993 and the earlier recorded ≈8,589/≈8,600; the exact total requires a full-range backfill (deferred) |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (ERC1967 proxy) was observed emitting `NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)` — separate future scope |

## Bounds

| Control | Value |
|---|---:|
| Scan window | 2,000,000 blocks, ending 256 blocks behind head |
| Scanned-event cap | 256 (fail closed above) |
| Accepted records | At most 24 newest |
| RPC requests | 3 per manual run |
| Response cap | 4 MiB |
| Derived URI view | 8 KiB (the retained raw event keeps the full value) |
| Request timeout | 20 seconds |
| Evidence retention | 90-day governance Object Lock |

## Evidence interpretation

A retained record is a **registration observation at the chain's word**: the owner and URI were recorded at registration and may have changed since. Inline registration JSON is decoded locally with no network access; its name and description remain self-asserted. No retained field may exceed Tier 2 / unverified; only a consented domain-control proof or publisher-key policy can upgrade trust.

## Projection rule

After the first run, an operator must recompute the stored-object SHA-256 and confirm governance retention. Each agent profile requires an explicit source-projection decision. The default is **not projected**.

## Deferred workstreams (out of scope for this pilot)

- Full backfill from the registry's deployment block in bounded chunks, with a persisted cursor (chain, block, log index) and reorg handling.
- `Transfer`-event tracking for ownership changes and ownership-based trust resets.
- Fetching agent URIs through the existing fetch safeguards as a separate, reviewed capability.
- Current `tokenURI`/`ownerOf` capture and `URIUpdated` tracking.
- The ERC-8004 Reputation Registry (`NewFeedback`) as a separate source.

## Required checks before activation

- [x] Hostname resolves to public, non-private address space (`netGuard` applies to every fetch)
- [x] One bounded read verified live from this hostname without a key and without redirects
- [x] Metadata-only read scope: no URI dereference, no wallet or transaction activity
- [x] Raw responses retained with SHA-256 and 90-day governance retention
- [x] First manual run completed and retained evidence reviewed
- [x] Public projection decision recorded

## Outcome

- [x] Registered in production: `1e6832f3-a18e-4067-8bc8-2260f2de63f8` (staged from `/admin/sources`, approved active; zero failed runs)
- [x] First bounded run completed (run `8ee21fd1…`, first success 2026-10-09T01:28:43Z UTC): 3 RPC reads; 63 `Registered` events scanned in the window; newest 24 accepted (agent ids 8614–8637); 39 older events outside the newest-24 bound
- [x] Complete-run batch evidence review passed (operator console, `liveData.admin.verifySourceEvidenceBatch`): 24/24 stored-object SHA-256 matches; `GOVERNANCE` Object Lock on every object; earliest `retainUntil` 2027-01-07T01:28:41Z; zero problem entries
- [x] Projection decision recorded: approved public as **Tier 2 / unverified** — census 58 → 82 (48 catalog + 24 ERC-8004 + 7 Solana registry + 3 A2A; 81 tier_2 + 1 tier_3); the 39 older registrations (ids 8575–8613) are deferred to the backfill workstream

## Addendum — backfill walk and adaptive narrowing (2026-10-09)

Wave 2 added a `backfill` mode beside the approved observe scan: one manual run acknowledges one older 2M-block window into the master directory (`agent_directory_entries` — locator-class facts only, never the reviewed spine), persisting a `bf:<block>` cursor that tiles backward from the observed newest window to genesis. Observe runs never erase a `bf:` position.

**Production incident (2026-10-09):** 39 failed backfill runs. The walk had silently committed windows 2–6 (~2,340 directory acknowledgements) and then parked deterministically on window `[70250678..72250678]`, which holds a 5,725-event mass-registration burst (4.33 MB) — above both the 4 MiB transport cap and the 2,000-event full-window budget, so every further click failed on the same window. Surrounding failures were transient Cloudflare-edge 403/429 streaks from rapid clicking, plus one Hostinger proxy 504 that hid an already-committed success.

**Fix bounds (backfill mode only; the approved observe scope is unchanged):**

| Control | Value |
|---|---:|
| Adaptive narrowing | newest-half splits per run, at most 24 (2M blocks → 1 block is 21 halvings) |
| Sub-window event cap | 10,000 (transport-bounded; full windows keep the 2,000-event budget) |
| Narrowed-scan acknowledgement | whole scanned sub-window, directory-only |
| Transient HTTP retry | 403/429/500/502/503/504; backoff 1.5 s then 3.5 s; at most 3 attempts per RPC call |
| No-skip invariant | the cursor resumes just below the scanned sub-window; the next 2M window re-tiles the skipped older half |
| Read-only scope | unchanged — the extra calls are the same filtered `eth_getLogs` |
