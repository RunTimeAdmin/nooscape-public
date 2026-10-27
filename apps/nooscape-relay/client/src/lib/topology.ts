type PositionedAgent = {
  id: string;
  position: { x: number; y: number };
  capability: string;
};

type TopologyCluster<T extends PositionedAgent> = {
  id: string;
  position: { x: number; y: number };
  count: number;
  representative: T;
  capability: string;
  members: readonly T[];
};

type TopologyLayer<T extends PositionedAgent> = {
  mode: "direct" | "regional" | "overview";
  direct: readonly T[];
  clusters: readonly TopologyCluster<T>[];
  total: number;
};

// "All records selected" should mean all records drawn; keep the direct bound
// high enough for the current index size and let the zoom-based level of detail
// below aggregate nearby records once the index outgrows the animated field.
const DIRECT_NODE_LIMIT = 160;

// Full bot characters are the costliest animated DOM on the field. The rendered
// surface is a bounded featured crew; every other record stays reachable through
// search/spotlight and shows as cheap non-interactive dust.
const FEATURED_BOT_LIMIT = 22;
export const DUST_PARTICLE_LIMIT = 140;

/**
 * Splits the visible index into the featured bot crew and background dust.
 * The selected agent and pinned comparison agents are always featured; the
 * remaining slots keep the caller's ordering, so callers pass agents already
 * sorted by prominence (trust flagships first, then freshest observations).
 */
export function pickFeaturedAgents<T extends { id: string }>(
  agents: readonly T[],
  selectedId: string,
  pinnedIds: readonly string[] = [],
  limit: number = FEATURED_BOT_LIMIT,
): { featured: T[]; dust: T[] } {
  const selected = agents.find(agent => agent.id === selectedId);
  const pinned = agents.filter(agent => pinnedIds.includes(agent.id) && agent.id !== selected?.id);
  const isPrioritized = (agent: T) => agent.id === selected?.id || pinnedIds.includes(agent.id);
  const ordered = [...(selected ? [selected] : []), ...pinned, ...agents.filter(agent => !isPrioritized(agent))];
  const featured = ordered.slice(0, Math.max(1, limit));
  const featuredIds = featured.map(agent => agent.id);
  return { featured, dust: agents.filter(agent => !featuredIds.includes(agent.id)) };
}

function sortedBySelectedFirst<T extends PositionedAgent>(agents: readonly T[], selectedId: string) {
  const selected = agents.find(agent => agent.id === selectedId);
  return selected ? [selected, ...agents.filter(agent => agent.id !== selected.id)] : [...agents];
}

function cellKey(agent: PositionedAgent, columns: number, rows: number) {
  const column = Math.min(columns - 1, Math.max(0, Math.floor((agent.position.x / 100) * columns)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((agent.position.y / 100) * rows)));
  return `${column}:${row}`;
}

function makeClusters<T extends PositionedAgent>(agents: readonly T[], columns: number, rows: number) {
  const buckets = new Map<string, T[]>();
  for (const agent of agents) {
    const key = cellKey(agent, columns, rows);
    const members = buckets.get(key) ?? [];
    members.push(agent);
    buckets.set(key, members);
  }

  const clusters: Array<TopologyCluster<T>> = [];
  buckets.forEach((members: T[], key: string) => {
    const representative: T = members[0]!;
    const position = members.reduce<{ x: number; y: number }>(
      (total, agent: T) => ({ x: total.x + agent.position.x, y: total.y + agent.position.y }),
      { x: 0, y: 0 },
    );
    const capabilities = Array.from(new Set<string>(members.map((agent: T) => agent.capability)));
    const mostCommonCapability = capabilities
      .sort((left, right) => members.filter((agent: T) => agent.capability === right).length - members.filter((agent: T) => agent.capability === left).length)[0] ?? representative.capability;

    clusters.push({
      id: `cluster:${columns}x${rows}:${key}`,
      position: { x: position.x / members.length, y: position.y / members.length },
      count: members.length,
      representative,
      capability: mostCommonCapability,
      members,
    });
  });
  return clusters;
}

/**
 * Bounds animated DOM/SVG work regardless of index size. The full agent list remains
 * available to search and detail views; overview cells simply aggregate nearby records.
 */
export function buildTopologyLayer<T extends PositionedAgent>(
  agents: readonly T[],
  selectedId: string,
  zoom = 1,
): TopologyLayer<T> {
  if (agents.length <= DIRECT_NODE_LIMIT) {
    return { mode: "direct", direct: sortedBySelectedFirst(agents, selectedId), clusters: [], total: agents.length };
  }

  const selected = agents.find(agent => agent.id === selectedId);
  const mode = zoom < 0.9 ? "overview" : zoom < 1.35 ? "regional" : "direct";
  if (mode === "direct") {
    const direct = sortedBySelectedFirst(agents, selectedId).slice(0, DIRECT_NODE_LIMIT);
    const directIds = new Set(direct.map(agent => agent.id));
    return {
      mode,
      direct,
      clusters: makeClusters(agents.filter(agent => !directIds.has(agent.id)), 8, 6),
      total: agents.length,
    };
  }

  const columns = mode === "overview" ? 4 : 7;
  const rows = mode === "overview" ? 3 : 5;
  const clusterAgents = selected ? agents.filter(agent => agent.id !== selected.id) : agents;
  return {
    mode,
    direct: selected ? [selected] : [],
    clusters: makeClusters(clusterAgents, columns, rows),
    total: agents.length,
  };
}

type TopologyEntity = { id: string; position: { x: number; y: number } };

export function connectionLinesForEntities<T extends TopologyEntity>(entities: readonly T[], selectedId: string) {
  const selected = entities.find(entity => entity.id === selectedId) ?? entities[0];
  if (!selected) return [];
  return entities.filter(entity => entity.id !== selected.id).map(entity => ({ from: selected, to: entity }));
}
