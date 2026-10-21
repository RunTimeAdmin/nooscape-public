/**
 * The arithmetic behind the "Clear the Fog" funnel, the fleet cards and the
 * count-up: pure, so none of it needs a browser to test. Every number it handles
 * is one the server reported, and a missing one stays missing: null is "not
 * measured yet", never a zero.
 */

export const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Fast at first, then settling: a count that climbs and lands. */
export const easeOutCubic = (progress: number) => 1 - Math.pow(1 - clamp01(progress), 3);

/** The number to show `progress` (0 to 1) of the way from `from` to `to`. Whole numbers, and exactly `to` at the end. */
export function countUpValue(from: number, to: number, progress: number): number {
  if (progress >= 1) return to;
  return Math.round(from + (to - from) * easeOutCubic(progress));
}

/** A bar's width as a percentage of the longest. Null stays null, a real zero is zero, and a real non-zero count is never thinner than 0.8% so it never vanishes. */
export function barPercent(value: number | null, max: number): number | null {
  if (value === null) return null;
  if (value <= 0) return 0;
  return Math.min(100, Math.max(0.8, (value / Math.max(max, 1)) * 100));
}

export type FunnelStep = { key: string; value: number | null };

/** The largest measured value, which the bars are drawn against. */
export const funnelMax = (steps: readonly FunnelStep[]) => steps.reduce((max, step) => Math.max(max, step.value ?? 0), 0);

/** The step that starts the evidence. Every step before it counts what registries list (the fog); it and every step after it count what Nooscape holds evidence for. */
export const EVIDENCE_FROM = "reviewed";

/** How long each step of the fog takes to clear. */
export const FOG_STAGE_MS = 600;

export type FogSplit = { fog: readonly FunnelStep[]; left: readonly FunnelStep[] };

/** The fog and what is left of it, or null when the funnel cannot say: no evidence step, nothing before it, or its count not measured yet. */
export function fogSplit(steps: readonly FunnelStep[]): FogSplit | null {
  const at = steps.findIndex(step => step.key === EVIDENCE_FROM);
  if (at < 1 || steps[at]!.value === null) return null;
  return { fog: steps.slice(0, at), left: steps.slice(at) };
}

export type FogRow = {
  key: string;
  value: number | null;
  role: "fog" | "left";
  /** When the row moves as the fog clears, in stages: a fog row at its own place in the list, and everything that is left together, one stage after the last of the fog. */
  stage: number;
  /** Its bar as a percentage of the longest step. */
  full: number | null;
  /** Its bar once the fog is cleared, as a percentage of the longest step that is left. Null for the fog, which goes. */
  zoomed: number | null;
};

export function fogRows(steps: readonly FunnelStep[]): FogRow[] {
  const split = fogSplit(steps);
  const longest = funnelMax(steps);
  const longestLeft = split ? funnelMax(split.left) : 0;
  return steps.map((step, index) => {
    const left = split !== null && index >= split.fog.length;
    return {
      key: step.key,
      value: step.value,
      role: left ? "left" : "fog",
      stage: left ? split!.fog.length : index,
      full: barPercent(step.value, longest),
      zoomed: left ? barPercent(step.value, longestLeft) : null,
    };
  });
}

/** When, after the fog starts to clear, each step of it has gone and the figure in view moves on to the next step: one stage apart, the last of them onto the evidence. */
export const stageDelays = (split: FogSplit): number[] => split.fog.map((_, index) => (index + 1) * FOG_STAGE_MS);

/** A wallet address shortened for a card: the start and end are enough to tell wallets apart, and the full text stays available. */
export function shortWallet(address: string): string {
  if (address.length <= 14) return address;
  const head = address.startsWith("0x") ? 6 : 4;
  return `${address.slice(0, head)}…${address.slice(-4)}`;
}

export type FleetWallet = { registrant: string; agentCount: number; dominantHost: string | null };

/** The wallets to show, largest count first, at most `limit`, each with its share of the largest as a percentage. A wallet with no recorded identities is dropped. */
export function fleetCards(wallets: readonly FleetWallet[], limit = 12): Array<FleetWallet & { share: number }> {
  const chosen = wallets.filter(wallet => wallet.agentCount > 0).sort((a, b) => b.agentCount - a.agentCount || (a.registrant < b.registrant ? -1 : 1)).slice(0, limit);
  const top = chosen[0]?.agentCount ?? 1;
  return chosen.map(wallet => ({ ...wallet, share: Math.max(2, (wallet.agentCount / top) * 100) }));
}
