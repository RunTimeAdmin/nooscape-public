import { layoutNodes, type ConstellationNode, type ConstellationRecord } from "./constellationModel";

/**
 * The map's layout, worked out off the page's thread. Placing the dots and the fleet lights took about 2.5 s with the
 * records of 22 November 2026 (302 records, 54 lights), and on the page's thread that froze the home page for as long:
 * the 3.3 s of blocking time a phone measured. A worker does it now, and gives back exactly what `layoutNodes` gives.
 */
export type LayoutRequest = { id: number; records: ConstellationRecord[]; aspect: number };
export type LayoutReply = { id: number; nodes: ConstellationNode[] };

/** Only what the layout reads, so the message carries plain data whatever else a record holds. */
export function layoutInput(records: readonly ConstellationRecord[]): ConstellationRecord[] {
  return records.map(({ agentId, displayName, handle, protocols, evidenceTier, kind, fleet }) => ({ agentId, displayName, handle, protocols, evidenceTier, kind, fleet }));
}

/** What the worker answers. */
export function answerLayout(request: LayoutRequest): LayoutReply {
  return { id: request.id, nodes: layoutNodes(request.records, request.aspect) };
}
