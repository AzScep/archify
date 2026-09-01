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
