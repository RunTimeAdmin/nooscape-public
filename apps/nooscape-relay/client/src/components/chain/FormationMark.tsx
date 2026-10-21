import type { CSSProperties } from "react";
import type { FleetShape } from "@shared/mapFleets";

/**
 * The mark for a group of registrations that share one fact: three stacked plates in the group's chain outline (a disc for BNB Chain, a
 * diamond for Solana, a hexagon for Robinhood Chain, the same outlines as the lights on the home map, a dome for Arc and a cross for Base,
 * which have no lights on the map and take the shapes of their home tabs). It is a landmark, not an agent:
 * its size says how many registrations share the fact, and nothing else.
 */
const PLATE: Record<FleetShape, string> = {
  circle: "M-44 0A44 17 0 1 0 44 0A44 17 0 1 0 -44 0Z",
  diamond: "M0 -21L46 0L0 21L-46 0Z",
  hexagon: "M-44 0L-22 -19L22 -19L44 0L22 19L-22 19Z",
  dome: "M-44 10A44 34 0 0 1 44 10Z",
  cross: "M-14 -19H14V-8H44V8H14V19H-14V8H-44V-8H-14Z",
};

type FormationMarkProps = { shape: FleetShape; size: number; tone: string };

export function FormationMark({ shape, size, tone }: FormationMarkProps) {
  const d = PLATE[shape];
  return (
    <svg
      viewBox="-52 -44 104 88"
      width={size}
      height={Math.round(size * 0.846)}
      className="cw-formation"
      data-shape={shape}
      style={{ color: tone } as CSSProperties}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="currentColor" stroke="currentColor" strokeLinejoin="round">
        <path d={d} transform="translate(0 14)" fillOpacity={0.05} strokeOpacity={0.35} strokeWidth={1.4} />
        <path d={d} transform="translate(0 4)" fillOpacity={0.09} strokeOpacity={0.6} strokeWidth={1.5} />
        <path d={d} transform="translate(0 -8)" fillOpacity={0.18} strokeOpacity={1} strokeWidth={1.9} />
        <path d={d} transform="translate(0 -8) scale(.3)" strokeWidth={0} fillOpacity={0.95} />
      </g>
    </svg>
  );
}
