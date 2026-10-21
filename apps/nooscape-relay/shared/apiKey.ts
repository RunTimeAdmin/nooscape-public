/**
 * What the API keys page, the developer page and the server all say about a key and its tiers (docs/data-access-2026-10-19.md,
 * stage D2). One place, so a limit cannot be one number on the page and another in the code.
 */

export const API_TIER_NAMES = ["free", "builder", "pro"] as const;
export type ApiTier = (typeof API_TIER_NAMES)[number];

/**
 * What each tier may ask. The free tier's numbers are the plan's. The plan gives the paid tiers a daily limit and no per-minute one, so
 * those are mine and are placeholders, as the prices are.
 */
export const API_TIERS: Record<ApiTier, { label: string; perMinute: number; perDay: number }> = {
  free: { label: "Free", perMinute: 60, perDay: 1_000 },
  builder: { label: "Builder", perMinute: 300, perDay: 50_000 },
  pro: { label: "Pro", perMinute: 1_200, perDay: 500_000 },
};

/** A key is "nsk_" and 40 characters of base64url (30 random bytes). */
export const KEY_PATTERN = /^nsk_[A-Za-z0-9_-]{40}$/;
/** How much of a key is kept in the clear, to tell keys apart. */
export const KEY_PREFIX_LENGTH = 10;

/** A tier is at least another when it comes at or after it in the list: free, builder, pro. */
export const tierAtLeast = (tier: ApiTier, minimum: ApiTier) => API_TIER_NAMES.indexOf(tier) >= API_TIER_NAMES.indexOf(minimum);

/**
 * The lowest tier that may call the pre-flight check (docs/data-access-2026-10-19.md, stage D3). The plan puts it with the Pro tier
 * and with pay per call (stage D4); until pay per call exists a Pro key is the only way in.
 */
export const CHECK_MIN_TIER: ApiTier = "pro";
