// Rank planning for automatic architecture layout.
// Run: node --test test/architecture-auto-ranks.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph, breakCycles, weakComponents, assignRanks, countCrossings,
} from '../renderers/architecture/auto-layout-ranks.mjs';

const comps = (...ids) => ids.map((id) => (typeof id === 'string' ? { id } : id));
const conns = (...pairs) => pairs.map(([from, to]) => ({ from, to }));
const ranksOf = (components, connections, problems = []) => {
  const graph = buildGraph(components, connections);
  const rank = assignRanks(graph, breakCycles(graph), problems);
  return Object.fromEntries(graph.nodes.map((n) => [n.id, rank[n.index]]));
};

test('a straight chain ranks left to right', () => {
  assert.deepEqual(ranksOf(comps('a', 'b', 'c'), conns(['a', 'b'], ['b', 'c'])), { a: 0, b: 1, c: 2 });
});

test('a diamond keeps the join one rank past its longest arm', () => {
  const rank = ranksOf(comps('a', 'b', 'c', 'd', 'e'), conns(['a', 'b'], ['a', 'c'], ['c', 'd'], ['b', 'e'], ['d', 'e']));
  assert.equal(rank.a, 0);
  assert.equal(rank.e, 3, 'join sits past the longer arm, not the shorter one');
  assert.ok(rank.b < rank.e && rank.d < rank.e);
});

test('a cycle is broken rather than hanging, and every arrow survives', () => {
  const graph = buildGraph(comps('a', 'b', 'c'), conns(['a', 'b'], ['b', 'c'], ['c', 'a']));
  const back = breakCycles(graph);
  assert.equal(back.size, 1, 'exactly one edge is demoted');
  assert.equal(graph.edges.length, 3, 'the back edge is still drawn, only ignored for ranking');
  const rank = assignRanks(graph, back);
  assert.deepEqual(rank, [0, 1, 2]);
});

test('self-loops are dropped and unknown endpoints ignored', () => {
  const graph = buildGraph(comps('a', 'b'), conns(['a', 'a'], ['a', 'ghost'], ['a', 'b']));
  assert.equal(graph.edges.length, 1);
});

test('cycle breaking is deterministic across repeated runs', () => {
  const build = () => buildGraph(comps('a', 'b', 'c', 'd'), conns(['a', 'b'], ['b', 'c'], ['c', 'b'], ['c', 'd'], ['d', 'a']));
  const first = [...breakCycles(build())].sort();
  for (let i = 0; i < 5; i += 1) assert.deepEqual([...breakCycles(build())].sort(), first);
});

test('disconnected blocks each start at rank 0', () => {
  const rank = ranksOf(comps('a', 'b', 'x', 'y'), conns(['a', 'b'], ['x', 'y']));
  assert.deepEqual(rank, { a: 0, b: 1, x: 0, y: 1 });
});

test('a lone node is its own block at rank 0', () => {
  assert.deepEqual(ranksOf(comps('a', 'b', 'solo'), conns(['a', 'b'])), { a: 0, b: 1, solo: 0 });
});

test('weakComponents splits on undirected connectivity', () => {
  const graph = buildGraph(comps('a', 'b', 'x'), conns(['b', 'a']));
  assert.deepEqual(weakComponents(graph).map((b) => b.length).sort(), [1, 2]);
});

test('tighten pulls a late-feeding source rightward instead of parking it at 0', () => {
  // `side` feeds only `c`, so it belongs beside `b`, not back at rank 0 with `a`.
  const rank = ranksOf(comps('a', 'b', 'c', 'side'), conns(['a', 'b'], ['b', 'c'], ['side', 'c']));
  assert.equal(rank.c, 2);
  assert.equal(rank.side, 1, 'source is tightened to one rank left of its only successor');
});

test('a rank pin is honored', () => {
  const rank = ranksOf([{ id: 'a' }, { id: 'b' }, { id: 'c', rank: 5 }], conns(['a', 'b'], ['b', 'c']));
  assert.equal(rank.c, 5);
});

test('a rank pin contradicting edge direction is diagnosed, not silently drawn', () => {
  const problems = [];
  ranksOf([{ id: 'a' }, { id: 'b', rank: 0 }], conns(['a', 'b']), problems);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /architecture\/explicit-pin-conflict/);
  assert.match(problems[0], /"a" -> "b"/);
  assert.match(problems[0], /Raise rank on "b"/, 'names a concrete remedy, per the house message contract');
});

test('a consistent pin raises no problem', () => {
  const problems = [];
  ranksOf([{ id: 'a' }, { id: 'b', rank: 3 }], conns(['a', 'b']), problems);
  assert.deepEqual(problems, []);
});

test('countCrossings finds the inversion and clears the parallel case', () => {
  const pairs = [{ upper: 'a', lower: 'y' }, { upper: 'b', lower: 'x' }];
  assert.equal(countCrossings(['a', 'b'], ['x', 'y'], pairs), 1);
  assert.equal(countCrossings(['a', 'b'], ['y', 'x'], pairs), 0);
});

test('side and group hints are read onto the nodes', () => {
  const graph = buildGraph([{ id: 'a', side: 'top' }, { id: 'b', side: 'bottom' }, { id: 'c', group: 'g' }, { id: 'd' }], []);
  assert.deepEqual(graph.nodes.map((n) => n.band), [-1, 1, 0, 0]);
  assert.equal(graph.nodes[2].group, 'g');
});

// ---- ordering ---------------------------------------------------------------

import { orderRanks } from '../renderers/architecture/auto-layout-ranks.mjs';

const plan = (components, connections) => {
  const graph = buildGraph(components, connections);
  const rank = assignRanks(graph, breakCycles(graph));
  return { graph, rank, layers: orderRanks(graph, rank) };
};
const idsAt = (layers, r, graph) => layers[r].map((m) => (m.node === null ? `~${m.edge}` : graph.nodes[m.node].id));

test('ordering places one entry per rank and keeps every component', () => {
  const { graph, layers } = plan(comps('a', 'b', 'c'), conns(['a', 'b'], ['b', 'c']));
  assert.equal(layers.length, 3);
  assert.deepEqual(layers.flat().filter((m) => m.node !== null).length, 3);
  assert.deepEqual(idsAt(layers, 0, graph), ['a']);
});

test('a spanning edge gets a virtual node on each rank it crosses', () => {
  // a->d spans ranks 0..3, so it needs stand-ins at ranks 1 and 2.
  const { layers } = plan(comps('a', 'b', 'c', 'd'), conns(['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd']));
  const virtual = layers.flat().filter((m) => m.node === null);
  assert.equal(virtual.length, 2, 'one stand-in per intermediate rank');
  assert.deepEqual(virtual.map((m) => m.edge), [3, 3]);
});

test('adjacent-rank edges need no virtual nodes', () => {
  const { layers } = plan(comps('a', 'b'), conns(['a', 'b']));
  assert.equal(layers.flat().filter((m) => m.node === null).length, 0);
});

test('the side hint dominates the barycenter', () => {
  const components = [{ id: 'a' }, { id: 'top', side: 'top' }, { id: 'bottom', side: 'bottom' }, { id: 'mid' }];
  const { graph, layers } = plan(components, conns(['a', 'top'], ['a', 'bottom'], ['a', 'mid']));
  assert.deepEqual(idsAt(layers, 1, graph), ['top', 'mid', 'bottom'], 'bands never interleave');
});

test('group members end up contiguous', () => {
  const components = [
    { id: 'a' },
    { id: 'g1', group: 'g' }, { id: 'loner' }, { id: 'g2', group: 'g' },
  ];
  const { graph, layers } = plan(components, conns(['a', 'g1'], ['a', 'loner'], ['a', 'g2']));
  const ids = idsAt(layers, 1, graph);
  assert.equal(Math.abs(ids.indexOf('g1') - ids.indexOf('g2')), 1, `expected g1/g2 adjacent, got ${ids}`);
});

test('ordering reduces crossings on a deliberately crossed graph', () => {
  const components = comps('a1', 'a2', 'b1', 'b2');
  const connections = conns(['a1', 'b2'], ['a2', 'b1']);
  const { graph, rank } = plan(components, connections);
  const layers = orderRanks(graph, rank);
  const pairs = [{ upper: 'a1', lower: 'b2' }, { upper: 'a2', lower: 'b1' }];
  const order = (r) => idsAt(layers, r, graph);
  assert.equal(countCrossings(order(0), order(1), pairs), 0, `expected an uncrossed order, got ${order(0)} / ${order(1)}`);
});

test('ordering is deterministic', () => {
  const run = () => {
    const { graph, layers } = plan(comps('a', 'b', 'c', 'd', 'e'), conns(['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'e'], ['e', 'd']));
    return layers.map((l, r) => idsAt(layers, r, graph).join(','));
  };
  const first = run();
  for (let i = 0; i < 5; i += 1) assert.deepEqual(run(), first);
});
