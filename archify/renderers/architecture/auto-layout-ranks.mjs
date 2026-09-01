// Rank and order planning for automatic architecture layout.
//
// Pure graph code: no pixels, no geometry, no renderer state. It answers two
// questions and nothing else — which layer does each component belong to, and
// in what order do the members of a layer sit. Coordinate assignment consumes
// the result; see auto-layout.mjs.
//
// Determinism is a hard requirement, not a nicety: golden byte-compares
// rendered output and `delta` diffs two snapshots, so every comparator here
// ends in an authored-index tiebreak and no iteration order depends on Map or
// Set insertion beyond the authored sequence.

/** Band offsets for the `side` hint. Unset stays on the main rail. */
const SIDE_BAND = { top: -1, bottom: 1 };

/**
 * Adjacency over authored components and connections. Self-loops are dropped
 * (they carry no ranking information) and connections naming an unknown id are
 * ignored — `validateArchitecture` reports those separately and with a better
 * message than anything this module could produce.
 */
export function buildGraph(components, connections) {
  const index = new Map(components.map((c, i) => [c.id, i]));
  const nodes = components.map((c, i) => ({
    id: c.id,
    index: i,
    rankPin: Number.isInteger(c.rank) ? c.rank : null,
    group: typeof c.group === 'string' ? c.group : null,
    band: SIDE_BAND[c.side] ?? 0,
  }));
  const edges = [];
  for (const [i, conn] of connections.entries()) {
    if (!index.has(conn.from) || !index.has(conn.to)) continue;
    if (conn.from === conn.to) continue;
    edges.push({ index: i, from: index.get(conn.from), to: index.get(conn.to), label: conn.label });
  }
  return { nodes, edges, index };
}

/**
 * Back edges of a DFS in authored order, sources first. Returned as a Set of
 * edge indices that ranking must ignore; the arrow itself is never reversed,
 * so the rendered diagram still points where the author said it points.
 */
export function breakCycles(graph) {
  const { nodes, edges } = graph;
  const out = nodes.map(() => []);
  for (const edge of edges) out[edge.from].push(edge);
  const indegree = nodes.map(() => 0);
  for (const edge of edges) indegree[edge.to] += 1;

  const WHITE = 0; const GREY = 1; const BLACK = 2;
  const color = nodes.map(() => WHITE);
  const backEdges = new Set();

  const visit = (start) => {
    // Explicit stack: a deep chain must not blow the call stack.
    const stack = [{ node: start, next: 0 }];
    color[start] = GREY;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next >= out[frame.node].length) {
        color[frame.node] = BLACK;
        stack.pop();
        continue;
      }
      const edge = out[frame.node][frame.next];
      frame.next += 1;
      if (color[edge.to] === GREY) backEdges.add(edge.index);
      else if (color[edge.to] === WHITE) {
        color[edge.to] = GREY;
        stack.push({ node: edge.to, next: 0 });
      }
    }
  };

  for (const node of nodes) if (indegree[node.index] === 0 && color[node.index] === WHITE) visit(node.index);
  for (const node of nodes) if (color[node.index] === WHITE) visit(node.index);
  return backEdges;
}

/** Weakly connected components, each a list of node indices in authored order. */
export function weakComponents(graph) {
  const parent = graph.nodes.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (const edge of graph.edges) {
    const [a, b] = [find(edge.from), find(edge.to)];
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const blocks = new Map();
  for (const node of graph.nodes) {
    const root = find(node.index);
    if (!blocks.has(root)) blocks.set(root, []);
    blocks.get(root).push(node.index);
  }
  return [...blocks.values()];
}

/**
 * Longest-path layering over the acyclic remainder, then one tightening pass
 * that pulls sources rightward. Plain longest path bunches every source at
 * rank 0 even when a source feeds only a late node; the tighten removes that
 * artifact. Network simplex would be the textbook answer and buys nothing at
 * the ~12 primary nodes SKILL.md calls for.
 *
 * Ranks are normalized per weakly connected block so every block starts at 0.
 */
export function assignRanks(graph, backEdges, problems = []) {
  const { nodes, edges } = graph;
  const live = edges.filter((edge) => !backEdges.has(edge.index));
  const out = nodes.map(() => []);
  const into = nodes.map(() => []);
  for (const edge of live) { out[edge.from].push(edge); into[edge.to].push(edge); }

  // Topological order over the acyclic remainder (Kahn, authored-order queue).
  const indegree = nodes.map((n) => into[n.index].length);
  const ready = nodes.filter((n) => indegree[n.index] === 0).map((n) => n.index);
  const topo = [];
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const node = ready.shift();
    topo.push(node);
    for (const edge of out[node]) {
      indegree[edge.to] -= 1;
      if (indegree[edge.to] === 0) ready.push(edge.to);
    }
  }

  const rank = nodes.map(() => 0);
  for (const node of topo) {
    for (const edge of out[node]) rank[edge.to] = Math.max(rank[edge.to], rank[node] + 1);
  }

  // Tighten: a source with successors sits one rank left of its earliest one.
  for (const node of nodes) {
    if (into[node.index].length || !out[node.index].length) continue;
    const earliest = Math.min(...out[node.index].map((edge) => rank[edge.to]));
    rank[node.index] = earliest - 1;
  }

  // Author pins win outright, then every block is renormalized to start at 0.
  for (const node of nodes) if (node.rankPin !== null) rank[node.index] = node.rankPin;
  for (const block of weakComponents(graph)) {
    const base = Math.min(...block.map((i) => rank[i]));
    for (const i of block) rank[i] -= base;
  }

  // A pin can contradict edge direction. Say so rather than drawing a lie.
  for (const edge of live) {
    if (rank[edge.from] < rank[edge.to]) continue;
    const from = nodes[edge.from]; const to = nodes[edge.to];
    if (from.rankPin === null && to.rankPin === null) continue;
    problems.push(
      `[architecture/explicit-pin-conflict] Connection "${from.id}" -> "${to.id}" needs an increasing rank, `
      + `but rank ${rank[edge.from]} -> ${rank[edge.to]} does not increase. `
      + `Raise rank on "${to.id}", lower it on "${from.id}", or drop the pin.`,
    );
  }
  return rank;
}

/** Crossings between two adjacent layers under the given orders. */
export function countCrossings(upper, lower, pairs) {
  const posUpper = new Map(upper.map((id, i) => [id, i]));
  const posLower = new Map(lower.map((id, i) => [id, i]));
  const live = pairs.filter((p) => posUpper.has(p.upper) && posLower.has(p.lower));
  let crossings = 0;
  for (let a = 0; a < live.length; a += 1) {
    for (let b = a + 1; b < live.length; b += 1) {
      const du = posUpper.get(live[a].upper) - posUpper.get(live[b].upper);
      const dl = posLower.get(live[a].lower) - posLower.get(live[b].lower);
      if (du * dl < 0) crossings += 1;
    }
  }
  return crossings;
}

/**
 * Order the members of each rank, reducing edge crossings.
 *
 * Long edges get a virtual node on every rank they span. That is not a
 * refinement: without it the ordering pass cannot see a spanning edge at all,
 * so it happily seats a component in the corridor that edge needs, and
 * `routeVia` then falls through to its deliberately-bad fallback route which
 * the author has no way to fix.
 *
 * `side` bands are applied as the primary sort key, so a hint always dominates
 * the barycenter; ordering only decides what happens inside a band.
 *
 * @returns {Array<Array<{key: string, node: number|null, edge: number|null}>>}
 *   one entry per rank, ordered.
 */
export function orderRanks(graph, rank, { sweeps = 4 } = {}) {
  const { nodes, edges } = graph;
  const rankCount = Math.max(0, ...rank.map((r) => r + 1));
  const layers = Array.from({ length: rankCount }, () => []);
  const meta = new Map();

  for (const node of nodes) {
    const key = `n${node.index}`;
    meta.set(key, { key, node: node.index, edge: null, band: node.band, order: node.index, group: node.group });
    layers[rank[node.index]].push(key);
  }
  // One virtual node per intermediate rank of every spanning edge.
  const chains = new Map();
  for (const edge of edges) {
    const [lo, hi] = [rank[edge.from], rank[edge.to]].sort((a, b) => a - b);
    if (hi - lo <= 1) continue;
    const chain = [];
    for (let r = lo + 1; r < hi; r += 1) {
      const key = `v${edge.index}_${r}`;
      meta.set(key, { key, node: null, edge: edge.index, band: 0, order: nodes.length + edge.index, group: null });
      layers[r].push(key);
      chain.push(key);
    }
    chains.set(edge.index, { lo, hi, chain });
  }

  // Adjacency over the expanded graph, so a spanning edge is a run of hops.
  const neighbours = new Map([...meta.keys()].map((k) => [k, { up: [], down: [] }]));
  const link = (a, b) => { neighbours.get(a).down.push(b); neighbours.get(b).up.push(a); };
  for (const edge of edges) {
    const forward = rank[edge.from] <= rank[edge.to];
    const [from, to] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
    const chain = chains.get(edge.index)?.chain ?? [];
    const path = [`n${from}`, ...(forward ? chain : [...chain].reverse()), `n${to}`];
    for (let i = 0; i + 1 < path.length; i += 1) if (path[i] !== path[i + 1]) link(path[i], path[i + 1]);
  }

  const positionsOf = (layer) => new Map(layer.map((k, i) => [k, i]));
  const median = (key, side, positions) => {
    const near = neighbours.get(key)[side].map((k) => positions.get(k)).filter((v) => v !== undefined);
    if (!near.length) return null;
    near.sort((a, b) => a - b);
    const mid = near.length >> 1;
    return near.length % 2 ? near[mid] : (near[mid - 1] + near[mid]) / 2;
  };
  const reorder = (layer, side, fixed) => {
    const positions = positionsOf(fixed);
    const current = new Map(layer.map((k, i) => [k, i]));
    return [...layer].sort((a, b) => {
      const ma = meta.get(a); const mb = meta.get(b);
      if (ma.band !== mb.band) return ma.band - mb.band;
      const va = median(a, side, positions) ?? current.get(a);
      const vb = median(b, side, positions) ?? current.get(b);
      if (va !== vb) return va - vb;
      return ma.order - mb.order;
    });
  };
  const totalCrossings = (state) => {
    let sum = 0;
    for (let r = 0; r + 1 < state.length; r += 1) {
      const pairs = [];
      for (const upper of state[r]) for (const lower of neighbours.get(upper).down) pairs.push({ upper, lower });
      sum += countCrossings(state[r], state[r + 1], pairs);
    }
    return sum;
  };

  for (const layer of layers) {
    layer.sort((a, b) => {
      const ma = meta.get(a); const mb = meta.get(b);
      return ma.band - mb.band || ma.order - mb.order;
    });
  }
  let best = layers.map((l) => [...l]);
  let bestScore = totalCrossings(best);
  let state = best.map((l) => [...l]);
  for (let pass = 0; pass < sweeps && bestScore > 0; pass += 1) {
    for (let r = 1; r < state.length; r += 1) state[r] = reorder(state[r], 'up', state[r - 1]);
    for (let r = state.length - 2; r >= 0; r -= 1) state[r] = reorder(state[r], 'down', state[r + 1]);
    const score = totalCrossings(state);
    if (score < bestScore) { bestScore = score; best = state.map((l) => [...l]); }
    else state = best.map((l) => [...l]);
  }

  // Group members sit together, ordered by where the group as a whole landed.
  for (const layer of best) {
    const rankOf = new Map(layer.map((k, i) => [k, i]));
    const groupAt = new Map();
    for (const key of layer) {
      const g = meta.get(key).group;
      if (!g) continue;
      groupAt.set(g, Math.min(groupAt.get(g) ?? Infinity, rankOf.get(key)));
    }
    if (!groupAt.size) continue;
    layer.sort((a, b) => {
      const ma = meta.get(a); const mb = meta.get(b);
      if (ma.band !== mb.band) return ma.band - mb.band;
      const ga = ma.group ? groupAt.get(ma.group) : rankOf.get(a);
      const gb = mb.group ? groupAt.get(mb.group) : rankOf.get(b);
      if (ga !== gb) return ga - gb;
      return rankOf.get(a) - rankOf.get(b);
    });
  }

  return best.map((layer) => layer.map((key) => meta.get(key)));
}

export default { buildGraph, breakCycles, weakComponents, assignRanks, countCrossings, orderRanks };
