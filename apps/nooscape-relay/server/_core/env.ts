export const ENV = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  nooscapeS3Endpoint: process.env.NOOSCAPE_S3_ENDPOINT ?? "",
  nooscapeS3Region: process.env.NOOSCAPE_S3_REGION ?? "",
  nooscapeS3Bucket: process.env.NOOSCAPE_S3_BUCKET ?? "",
  nooscapeS3AccessKey: process.env.NOOSCAPE_S3_ACCESS_KEY ?? "",
  nooscapeS3SecretKey: process.env.NOOSCAPE_S3_SECRET_KEY ?? "",
  nooscapeEvidenceRetentionDays: process.env.NOOSCAPE_EVIDENCE_RETENTION_DAYS ?? "",
  nooscapeEvidenceSigningPrivateKey: process.env.NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY ?? "",
  nooscapeEvidenceSigningKeyId: process.env.NOOSCAPE_EVIDENCE_SIGNING_KEY_ID ?? "",
  /**
   * Keys that no longer sign but whose packets must still verify, and keys that were revoked. A JSON array of
   * { keyId, publicKeyPem, status: "retired" | "revoked", retiredAt, note? }, Ed25519 keys only. retiredAt (an ISO
   * date) is required for "retired" and bounds it: a packet dated later is refused. Empty means there are none. The
   * active key is not listed here: it comes from the signing key above. See docs/evidence-key-rotation.md.
   */
  nooscapeEvidenceRetiredKeys: process.env.NOOSCAPE_EVIDENCE_RETIRED_KEYS ?? "",
  /**
   * Solana JSON-RPC endpoint for on-chain registry reads. The public mainnet
   * endpoint works for bounded reads (SOLANA_INGEST_SPEC.md §7) but is
   * explicitly "not intended for production" and rate-limits per IP, so
   * scheduled runs should point at a keyed provider (Helius/QuickNode) via
   * this variable. Provider URLs carry their key in the query string, so the
   * value stays in the environment and is never stored in the database.
   */
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  /**
   * BNB Smart Chain archive JSON-RPC endpoint for the ERC-8004 identity pass.
   * Unlike the Solana variable there is no public default: the pass needs an
   * archive provider that serves history (NodeReal, whose endpoint URL carries
   * the key in its path). The value stays in the environment, is never stored
   * in the database or a source row, and must never appear in an error, a log
   * line, or a run record. Unset means the pass refuses to run.
   */
  bscRpcUrl: process.env.BSC_RPC_URL ?? "",
  /**
   * Ethereum mainnet archive JSON-RPC endpoint for the ERC-8004 identity pass (docs/multichain-erc8004-2026-10-20.md). Like the
   * BNB Chain variable: a NodeReal endpoint whose path carries the key, read when the server starts, never stored in the database or
   * written to an error, a log line or a run record. Unset means the Ethereum pass refuses to run.
   */
  ethRpcUrl: process.env.ETH_RPC_URL ?? "",
  /**
   * Base mainnet endpoint for the ERC-8004 identity pass: an Alchemy endpoint whose path carries the key. The plan must allow
   * `eth_getLogs` over wide block ranges (the Free tier allows 10 blocks), because the pass walks the registry's whole history
   * from block 41,663,783. Same rules as the other two: environment only, never printed, unset means the Base pass refuses to run.
   */
  baseRpcUrl: process.env.BASE_RPC_URL ?? "",
};
