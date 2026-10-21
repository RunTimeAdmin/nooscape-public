import type { CSSProperties } from "react";

/**
 * A small scout for one record or entry. It is an illustration: the same id always draws the same scout (a body, a pair of eyes and a
 * crown picked from the id), and nothing about it says anything about the agent. Reviewed records are drawn solid and entries the
 * directory lists and Nooscape has not reviewed are drawn hollow and dashed, so the difference is in the outline and not in colour alone.
 *
 * One drawing, no gradients and no ids of its own, so a crowd of them stays light.
 */

export const FIGURE_BODIES = 3;
export const FIGURE_EYES = 3;
export const FIGURE_CROWNS = 4;

function hashAgentId(agentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Which body, eyes and crown an id gets. 36 scouts in all; the same id is always the same one. */
export function figureParts(agentId: string): { body: number; eyes: number; crown: number } {
  const hash = hashAgentId(agentId);
  return { body: hash % FIGURE_BODIES, eyes: Math.floor(hash / 3) % FIGURE_EYES, crown: Math.floor(hash / 9) % FIGURE_CROWNS };
}

const BODY_PATHS = [
  // dome: an owlet's rounded back
  "M10 41C10 29 18 21 28 21S46 29 46 41V50Q46 54 42 54H14Q10 54 10 50Z",
  // box: a square little drone
  "M12 24H44Q48 24 48 28V50Q48 54 44 54H12Q8 54 8 50V28Q8 24 12 24Z",
  // shield: a pointed body
  "M28 20L46 28V46L28 56L10 46V28Z",
] as const;

type AgentFigureProps = {
  agentId: string;
  /** The chain's colour. */
  tone: string;
  kind?: "reviewed" | "acknowledged";
  large?: boolean;
};

export function AgentFigure({ agentId, tone, kind = "reviewed", large = false }: AgentFigureProps) {
  const { body, eyes, crown } = figureParts(agentId);
  const hollow = kind === "acknowledged";
  const outline = { stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round", strokeLinecap: "round" } as const;
  const solid = hollow ? { fill: "none" } : { fill: "currentColor", fillOpacity: 0.16 };
  const eyeFill = hollow ? { fill: "none", strokeWidth: 1.5 } : { fill: "currentColor", strokeWidth: 0 };
  return (
    <svg
      viewBox="0 0 56 64"
      className={`cw-figure cw-figure--${kind}${large ? " cw-figure--large" : ""}`}
      style={{ color: tone } as CSSProperties}
      data-kind={kind}
      data-body={body}
      data-eyes={eyes}
      data-crown={crown}
      aria-hidden="true"
      focusable="false"
    >
      <g {...outline} {...solid} strokeDasharray={hollow ? "3.2 2.6" : undefined} strokeOpacity={hollow ? 0.85 : 1}>
        {crown === 0 && (
          <>
            <path d="M13 25L11 12L22 21Z" />
            <path d="M43 25L45 12L34 21Z" />
          </>
        )}
        {crown === 3 && <path d="M18 22Q28 11 38 22" fill="none" />}
        <path d="M17 54H24V58.5Q24 59 23.5 59H17.5Q17 59 17 58.5Z" />
        <path d="M32 54H39V58.5Q39 59 38.5 59H32.5Q32 59 32 58.5Z" />
        <path d={BODY_PATHS[body]} />
      </g>
      <g {...outline} fill="none">
        {crown === 1 && (
          <>
            <path d="M28 21V11" />
            <circle cx="28" cy="8.2" r="2.6" {...eyeFill} />
          </>
        )}
        {crown === 2 && (
          <>
            <path d="M22 22L18 10.5M34 22L38 10.5" />
            <circle cx="17.6" cy="8.6" r="2.1" {...eyeFill} />
            <circle cx="38.4" cy="8.6" r="2.1" {...eyeFill} />
          </>
        )}
      </g>
      <g {...outline}>
        {eyes === 0 && (
          <>
            <circle cx="21" cy="38" r="3.4" {...eyeFill} />
            <circle cx="35" cy="38" r="3.4" {...eyeFill} />
          </>
        )}
        {eyes === 1 && (
          <>
            <rect x="15" y="33.5" width="26" height="9" rx="4.5" fill="none" strokeWidth={1.5} />
            <circle cx="28" cy="38" r="2.3" {...eyeFill} />
          </>
        )}
        {eyes === 2 && (
          <>
            <circle cx="28" cy="38" r="6" fill="none" strokeWidth={1.5} />
            <circle cx="28" cy="38" r="2.7" {...eyeFill} />
          </>
        )}
      </g>
    </svg>
  );
}
