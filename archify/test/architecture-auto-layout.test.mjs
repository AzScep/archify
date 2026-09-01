// Sizing, placement and label resolution for automatic architecture layout.
// Run: node --test test/architecture-auto-layout.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoLayout, sizeComponent, textWidthAtPreferred, widthBudget, autoOptions, separateBoundaries,
} from '../renderers/architecture/auto-layout.mjs';
import { fittedNodeFontSize } from '../renderers/shared/text-fit.mjs';
import { rectsOverlap, segmentIntersectsRect } from '../renderers/shared/geometry.mjs';

const doc = (components, connections = [], extra = {}) => ({
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'T', quality_profile: 'showcase' },
  layout: { mode: 'auto' },
  components,
  connections,
  ...extra,
});
const node = (id, rest = {}) => ({ id, type: 'backend', label: id, ...rest });

test('a document without auto mode is left entirely alone', () => {
  assert.equal(autoLayout({ layout: { mode: 'grid' }, components: [] }), null);
  assert.equal(autoLayout({ components: [] }), null);
});

test('nodes are sized so their text keeps its preferred font', () => {
  const options = autoOptions({});
  const c = node('a', { sublabel: 'a fairly long sublabel here' });
  const { width } = sizeComponent(c, options);
  assert.equal(fittedNodeFontSize(c.sublabel, width, 9, 6), 9,
    'sizing to the text is what keeps the sublabel off the 6px floor');
});

test('an authored size is a hard pin', () => {
  const { width, height, pinned } = sizeComponent(node('a', { size: [321, 77] }), autoOptions({}));
  assert.deepEqual([width, height, pinned], [321, 77, true]);
});

test('widths stay even so cx lands exactly on the rank centre', () => {
  // defaultFromSide only prefers top/bottom over left/right at exact equality,
  // so an off-by-a-half centre silently changes how same-rank edges route.
  for (const label of ['a', 'abc', 'a much longer label', 'xy']) {
    assert.equal(sizeComponent(node('n', { label }), autoOptions({})).width % 2, 0);
  }
});

test('a short label still gets the minimum width', () => {
  assert.equal(sizeComponent(node('a', { label: 'x' }), autoOptions({})).width, 120);
});

test('textWidthAtPreferred is zero for absent text', () => {
  assert.equal(textWidthAtPreferred(undefined, 9), 0);
  assert.equal(textWidthAtPreferred('', 9), 0);
});

test('the width budget follows the readability floor', () => {
  // 930px of reader width, 6px floor: 9px sublabels buy 1395px of canvas.
  assert.equal(widthBudget([node('a', { sublabel: 's' })]), 1395);
  assert.equal(widthBudget([node('a')]), 1705);
});

test('placement separates every pair by the validator minimum', () => {
  const components = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
  const connections = [['a', 'b'], ['b', 'c'], ['a', 'd'], ['d', 'c'], ['c', 'e']]
    .map(([from, to]) => ({ from, to }));
  const plan = autoLayout(doc(components, connections));
  const boxes = [...plan.components.values()];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.ok(!rectsOverlap(boxes[i], boxes[j], 8), `components ${i}/${j} sit closer than 8px`);
    }
  }
});

test('every measured box carries its id', () => {
  // automaticPortSpread groups ports by rect.id; id-less boxes all hash alike
  // and fan unrelated connections apart, so the solver scores routes the
  // renderer will never draw.
  const plan = autoLayout(doc([node('a'), node('b')], [{ from: 'a', to: 'b' }]));
  for (const [id, box] of plan.components) assert.equal(box.id, id);
});

test('ranks advance left to right', () => {
  const plan = autoLayout(doc([node('a'), node('b'), node('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]));
  const x = (id) => plan.components.get(id).x;
  assert.ok(x('a') < x('b') && x('b') < x('c'));
});

test('an authored pos pins a node and the rest place around it', () => {
  const plan = autoLayout(doc(
    [node('a'), node('pinned', { pos: [500, 400] }), node('c')],
    [{ from: 'a', to: 'pinned' }, { from: 'pinned', to: 'c' }],
  ));
  const box = plan.components.get('pinned');
  assert.deepEqual([box.x, box.y], [500, 400]);
});

test('placement is deterministic', () => {
  const build = () => autoLayout(doc(
    ['a', 'b', 'c', 'd'].map((id) => node(id)),
    [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
  ));
  const snapshot = (p) => JSON.stringify([...p.components.entries()]);
  const first = snapshot(build());
  for (let i = 0; i < 5; i += 1) assert.equal(snapshot(build()), first);
});

test('a boundary never encloses a component it does not wrap', () => {
  // The frame is derived from its members and grows to hold a title that is
  // itself pushed above blockers, so an unseparated boundary can end up
  // visibly containing components that are not in it.
  const components = ['a', 'b', 'c', 'inside1', 'inside2'].map((id) => node(id));
  const connections = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'inside1' }, { from: 'inside1', to: 'inside2' }];
  const arch = doc(components, connections, {
    boundaries: [{ kind: 'security-group', label: 'A boundary with a fairly long title', wraps: ['inside1', 'inside2'] }],
  });
  const plan = autoLayout(arch);
  const wraps = new Set(['inside1', 'inside2']);
  const members = [...wraps].map((id) => plan.components.get(id));
  const left = Math.min(...members.map((m) => m.x)) - 30;
  const right = Math.max(...members.map((m) => m.x + m.width)) + 30;
  const top = Math.min(...members.map((m) => m.y));
  for (const [id, box] of plan.components) {
    if (wraps.has(id)) continue;
    const overlapsX = box.x + box.width > left && box.x < right;
    assert.ok(!(overlapsX && box.y < top && box.y + box.height > top - 30),
      `${id} sits in the title rail of a boundary it is not a member of`);
  }
});

test('separateBoundaries is a no-op when nothing intrudes', () => {
  const measured = new Map([
    ['m', { id: 'm', x: 0, y: 200, width: 100, height: 60, cx: 50, cy: 230 }],
    ['far', { id: 'far', x: 400, y: 0, width: 100, height: 60, cx: 450, cy: 30 }],
  ]);
  const before = JSON.stringify([...measured]);
  separateBoundaries({ boundaries: [{ label: 'b', wraps: ['m'] }] }, measured, autoOptions({}), []);
  assert.equal(JSON.stringify([...measured]), before);
});

// ---- repair passes ----------------------------------------------------------

import { countRouteCrossings, enforceSeparation, demoteStaleRoutes } from '../renderers/architecture/auto-layout.mjs';
import { createRouter } from '../renderers/architecture/routing.mjs';

test('enforceSeparation restores the 8px minimum after boxes are moved', () => {
  // separateBoundaries shifts whole member sets after vertical assignment, so
  // a member can be pushed back into a neighbour it was already clear of.
  const options = autoOptions({});
  const measured = new Map([
    ['a', { id: 'a', rank: 0, x: 0, y: 0, width: 120, height: 60, cx: 60, cy: 30 }],
    ['b', { id: 'b', rank: 0, x: 0, y: 59, width: 120, height: 60, cx: 60, cy: 89 }],
  ]);
  enforceSeparation(measured, options);
  assert.ok(!rectsOverlap(measured.get('a'), measured.get('b'), 8));
});

test('the solver leaves no proper crossing on a graph that invites one', () => {
  // Two independent flows whose endpoints are ordered to cross.
  const components = ['a1', 'a2', 'b1', 'b2'].map((id) => node(id));
  const connections = [{ from: 'a1', to: 'b2' }, { from: 'a2', to: 'b1' }];
  const plan = autoLayout(doc(components, connections));
  assert.equal(countRouteCrossings(plan.components, plan.connections), 0);
});

test('countRouteCrossings exempts relationships sharing an endpoint', () => {
  const plan = autoLayout(doc(
    ['hub', 'x', 'y'].map((id) => node(id)),
    [{ from: 'hub', to: 'x' }, { from: 'hub', to: 'y' }],
  ));
  assert.equal(countRouteCrossings(plan.components, plan.connections), 0);
});

test('the drawing is pulled up against its top margin', () => {
  // Repair passes only ever push boxes down, so without normalisation the whole
  // drawing drifts off the top edge into a dead band no gate measures.
  const plan = autoLayout(doc(
    ['a', 'b', 'c'].map((id) => node(id)),
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  ));
  const top = Math.min(...[...plan.components.values()].map((b) => b.y));
  assert.equal(top, autoOptions({}).margin);
});

test('a component outside every boundary stays outside its frame', () => {
  // Upstream's ROADMAP names "Auth Provider floating outside the AWS region" as
  // the kind of decision auto layout destroys. It survives here because
  // boundary membership, not proximity, decides the frame.
  const components = ['auth', 'edge', 'api', 'db'].map((id) => node(id));
  const arch = doc(components, [{ from: 'auth', to: 'api' }, { from: 'edge', to: 'api' }, { from: 'api', to: 'db' }], {
    boundaries: [{ kind: 'region', label: 'Region', wraps: ['edge', 'api', 'db'] }],
  });
  const plan = autoLayout(arch);
  const members = ['edge', 'api', 'db'].map((id) => plan.components.get(id));
  const frame = {
    x: Math.min(...members.map((m) => m.x)) - 30,
    y: Math.min(...members.map((m) => m.y)) - 30,
    right: Math.max(...members.map((m) => m.x + m.width)) + 30,
    bottom: Math.max(...members.map((m) => m.y + m.height)) + 50,
  };
  const auth = plan.components.get('auth');
  const enclosed = auth.x >= frame.x && auth.x + auth.width <= frame.right
    && auth.y >= frame.y && auth.y + auth.height <= frame.bottom;
  assert.ok(!enclosed, 'a non-member must not end up inside the frame');
});

// ---- corridor reservation ---------------------------------------------------

test('an edge spanning several ranks keeps a lane clear of components', () => {
  // The stand-ins for a long edge are only a reservation once they are aligned
  // with the edge they represent; unaligned they never move and the router
  // drives the edge straight through whatever component sits in the way.
  // This is the guarantee - a clear lane. Crossing repair is separate, and
  // only swaps real components, so it cannot always straighten a corridor.
  const components = ['a', 'b', 'c', 'd', 'blocker'].map((id) => node(id));
  const connections = [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' },
    { from: 'a', to: 'd' }, { from: 'b', to: 'blocker' },
  ];
  const plan = autoLayout(doc(components, connections));
  const { pathFor } = createRouter(plan.components, plan.connections);
  for (const conn of plan.connections) {
    const points = pathFor(conn).points;
    for (const [id, box] of plan.components) {
      if (id === conn.from || id === conn.to) continue;
      for (let i = 0; i + 1 < points.length; i += 1) {
        const segment = { start: points[i], end: points[i + 1] };
        assert.ok(!segmentIntersectsRect(segment, box, 2),
          `${conn.from}->${conn.to} runs through ${id}`);
      }
    }
  }
});

test('a return path is laid out without crossing the forward flow', () => {
  const components = ['a', 'b', 'c', 'd'].map((id) => node(id));
  const connections = [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' },
    { from: 'd', to: 'b' }, // the return path, three ranks backwards
  ];
  const plan = autoLayout(doc(components, connections));
  assert.equal(countRouteCrossings(plan.components, plan.connections), 0);
  assert.ok(['top', 'bottom'].includes(plan.returnLane));
});

test('the return lane is chosen by measurement, and can be pinned', () => {
  const components = ['a', 'b', 'c'].map((id) => node(id));
  const connections = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }];
  const arch = doc(components, connections);
  arch.layout = { mode: 'auto', returnLane: 'top' };
  assert.equal(autoLayout(arch).returnLane, 'top');
});


test('a route hint the solver has invalidated is demoted', () => {
  // route: "straight" makes routeVia return [] before generating any candidate
  // at all - no clearance check, no fallback. Correct for a hand-placed diagram
  // where the author aligned the two boxes; under auto layout that alignment
  // never existed, so the "straight" line is a diagonal nothing can repair.
  const measured = new Map([
    ['a', { id: 'a', cx: 100, cy: 100 }],
    ['b', { id: 'b', cx: 300, cy: 300 }],
    ['c', { id: 'c', cx: 300, cy: 100 }],
  ]);
  const [diagonal, aligned, other] = demoteStaleRoutes([
    { from: 'a', to: 'b', route: 'straight' },
    { from: 'a', to: 'c', route: 'straight' },
    { from: 'a', to: 'b', route: 'orthogonal-h' },
  ], measured);
  assert.equal(diagonal.route, undefined, 'a straight hint between unaligned boxes is dropped');
  assert.equal(aligned.route, 'straight', 'a straight hint between aligned boxes is honoured');
  assert.equal(other.route, 'orthogonal-h',
    'orthogonal hints stay: they are axis-aligned from any placement, so unlovely at worst');
});
