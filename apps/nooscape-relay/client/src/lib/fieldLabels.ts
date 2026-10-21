/**
 * Which agents on the field map get a name beside them, and on which side.
 *
 * The map draws up to 22 agents in a box a few hundred pixels across, and a name at a readable size (12px DM Mono is
 * 7.44px a character) is too wide for all of them to fit. Names are placed one at a time in the order given, the
 * selected agent first and then the rest as the map lists them. A name goes to the right of its node, or to the left
 * when the right has no room, and a name that would touch another name, another node or the mark in the middle is left
 * out. An agent left out is still a button with its name as its label, and shows the name when it is pointed at or
 * has focus.
 */

/** A node as the plan sees it: where it sits (percent of the map) and the words its label would carry. */
export type LabelNode = { id: string; x: number; y: number; name: string; detail: string };

/** Where a name goes: beside its node on `side`, no wider than `width` pixels (a longer name is cut short). */
export type LabelPlace = { side: "right" | "left"; width: number };

export type Rect = { x: number; y: number; w: number; h: number };

/** DM Mono is 0.6em across. The names add 0.02em of letter spacing, the capability line (in capitals) 0.04em. */
export const NAME_CHAR_PX = 7.44;
export const DETAIL_CHAR_PX = 7.68;
/** What `.agent-label` adds around its words (index.css): 6px each side, and 16px lines with 1px above and below. */
export const LABEL_PAD_X = 6;
export const LABEL_LINE_PX = 16;
export const LABEL_PAD_Y = 1;
/** The widest a name is drawn, and the widest the selected agent's two lines are drawn. */
export const LABEL_MAX_PX = 168;
export const SELECTED_MAX_PX = 224;
/** The narrowest the selected agent's label is squeezed to when its node is too close to the edge for more. */
export const LABEL_MIN_PX = 56;
/** From a node's centre to the near edge of its label: 26px from the node's left edge, and the node is 20px across. */
const NODE_TO_LABEL = 16;
/** How far a node's bot, its glow and its bobbing reach from its centre, so a name keeps clear of it. */
const MARKER_REACH = 14;
const GAP = 4;
const EDGE = 4;
/** The mark in the middle of the map (the core and the words under it), as a box around the map's centre. */
const CENTRE = { halfWidth: 65, above: 30, below: 84, at: 0.51 };

function boxesTouch(a: Rect, b: Rect, gap = GAP) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

const inside = (box: Rect, scene: { width: number; height: number }) => box.x >= EDGE && box.y >= EDGE && box.x + box.w <= scene.width - EDGE && box.y + box.h <= scene.height - EDGE;

/** The width a name wants, cut at `max`. */
function nameWidth(name: string, max: number) {
  return Math.min(max, Math.ceil(name.length * NAME_CHAR_PX + 2 * LABEL_PAD_X));
}

/** The width the selected agent's two lines want, cut at `SELECTED_MAX_PX`. */
function selectedWidth(node: LabelNode) {
  return Math.min(SELECTED_MAX_PX, Math.ceil(Math.max(node.name.length * NAME_CHAR_PX, node.detail.length * DETAIL_CHAR_PX) + 2 * LABEL_PAD_X));
}

const LINE_BOX = LABEL_LINE_PX + 2 * LABEL_PAD_Y;
/** Two lines and the 2px between them. */
const TWO_LINE_BOX = 2 * LABEL_LINE_PX + 2 + 2 * LABEL_PAD_Y;

/** The box a label covers when its node's centre is at (cx, cy) and it sits on `side`. */
function boxAt(cx: number, cy: number, side: "right" | "left", w: number, h: number): Rect {
  return { x: side === "right" ? cx + NODE_TO_LABEL : cx - NODE_TO_LABEL - w, y: cy - h / 2, w, h };
}

/** The pixels a planned label covers: what the plan kept clear for it. The selected agent's label has two lines, the rest one. */
export function labelRect(node: LabelNode, place: LabelPlace, scene: { width: number; height: number }, selected: boolean): Rect {
  return boxAt((node.x / 100) * scene.width, (node.y / 100) * scene.height, place.side, place.width, selected ? TWO_LINE_BOX : LINE_BOX);
}

/**
 * The names that fit on a map `scene.width` by `scene.height` pixels, each with its side and width. An agent that is not
 * in the result gets no name on the map. The selected agent always gets one, squeezed if it must be.
 */
export function planLabels(nodes: readonly LabelNode[], scene: { width: number; height: number }, selectedId: string | null): Map<string, LabelPlace> {
  const plan = new Map<string, LabelPlace>();
  if (scene.width < 2 * EDGE + LABEL_MIN_PX || scene.height < 2 * EDGE + TWO_LINE_BOX) return plan;

  const centres = nodes.map(node => ({ node, cx: (node.x / 100) * scene.width, cy: (node.y / 100) * scene.height }));
  const markers = centres.map(({ node, cx, cy }) => ({ id: node.id, box: { x: cx - MARKER_REACH, y: cy - MARKER_REACH, w: 2 * MARKER_REACH, h: 2 * MARKER_REACH } }));
  const middle: Rect = { x: scene.width / 2 - CENTRE.halfWidth, y: scene.height * CENTRE.at - CENTRE.above, w: 2 * CENTRE.halfWidth, h: CENTRE.above + CENTRE.below };
  const placed: Rect[] = [];

  const blocked = (candidate: Rect, ownId: string) => markers.some(marker => marker.id !== ownId && boxesTouch(candidate, marker.box, 0)) || boxesTouch(candidate, middle, 0);

  // The selected agent first: it always gets a name, and everything else keeps clear of it. A side that is on the map and
  // clear of every other node is best; failing that, a side that is on the map; failing that, the side with more room, squeezed.
  const selected = centres.find(({ node }) => node.id === selectedId);
  if (selected) {
    const w = selectedWidth(selected.node);
    const tries = (["right", "left"] as const).map(side => ({ side, box: boxAt(selected.cx, selected.cy, side, w, TWO_LINE_BOX) }));
    const fits = tries.find(({ box }) => inside(box, scene) && !blocked(box, selected.node.id)) ?? tries.find(({ box }) => inside(box, scene));
    if (fits) {
      plan.set(selected.node.id, { side: fits.side, width: w });
      placed.push(fits.box);
    } else {
      const room = (side: "right" | "left") => (side === "right" ? scene.width - EDGE - (selected.cx + NODE_TO_LABEL) : selected.cx - NODE_TO_LABEL - EDGE);
      const side = room("right") >= room("left") ? "right" : "left";
      const width = Math.max(LABEL_MIN_PX, Math.min(w, Math.floor(room(side))));
      plan.set(selected.node.id, { side, width });
      placed.push(boxAt(selected.cx, selected.cy, side, width, TWO_LINE_BOX));
    }
  }

  for (const { node, cx, cy } of centres) {
    if (node.id === selectedId) continue;
    const w = nameWidth(node.name, LABEL_MAX_PX);
    for (const side of ["right", "left"] as const) {
      const candidate = boxAt(cx, cy, side, w, LINE_BOX);
      if (!inside(candidate, scene)) continue;
      if (placed.some(other => boxesTouch(candidate, other))) continue;
      if (blocked(candidate, node.id)) continue;
      plan.set(node.id, { side, width: w });
      placed.push(candidate);
      break;
    }
  }
  return plan;
}
