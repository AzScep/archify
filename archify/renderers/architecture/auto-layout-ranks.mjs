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

export default { buildGraph, breakCycles, weakComponents, assignRanks, countCrossings };
