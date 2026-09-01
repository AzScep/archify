// Automatic placement for architecture diagrams (`layout.mode: "auto"`).
//
// Turns a component/connection graph into measured boxes. Ranks and order come
// from auto-layout-ranks.mjs; this module owns sizes and coordinates.
//
// Free placement and grid mode are untouched, so every existing document keeps
// its authored geometry byte for byte.

import { textUnits } from '../shared/utils.mjs';
import { nodeTextFit } from '../shared/text-fit.mjs';
import { rectsOverlap, labelPoint, collectLabelRouteClearance } from '../shared/geometry.mjs';
import {
  minimumReadableSourceTextPx,
  DESKTOP_READER_DIAGRAM_WIDTH,
  MIN_PROJECTED_NODE_TEXT_PX,
} from '../shared/desktop-readability.mjs';
import { createRouter } from './routing.mjs';
import { buildGraph, breakCycles, assignRanks, orderRanks } from './auto-layout-ranks.mjs';

/** Preferred source font per node text field, from render-architecture.mjs. */
const NODE_TEXT = { label: 11, sublabel: 9, tag: 7 };

/** Floor for rank clear space when the width budget forces tightening. */
const MIN_RANK_GAP = 40;

export const AUTO_DEFAULTS = {
  flow: 'lr',
  rankPitch: 150,
  nodeGapY: 36,
  maxNodeW: 260,
  minNodeW: 120,
  nodeH: 60,
  nodeHWithTag: 64,
  margin: 40,
  /** Clear space between adjacent ranks before widths are added. */
  rankGap: 96,
  /** Extra clearance when a labeled connection crosses a rank gap. */
  labelGap: 8,
  /** Vertical lane a spanning edge reserves on the ranks it crosses. */
  corridor: 16,
};

export function autoOptions(arch) {
  return { ...AUTO_DEFAULTS, ...(arch.layout ?? {}) };
}

/**
 * Width at which `text` still renders at its preferred font size.
 *
 * `fittedNodeFontSize` shrinks text to fit the box; sizing the box to the text
 * instead is the whole point of auto mode. A sublabel held at 9px rather than
 * shrunk to the 6px floor raises the viewBox width budget from 930px to
 * 1395px, because the desktop readability gate projects source px through
 * `min(1, 930 / viewBoxWidth)` and fails below 6.
 */
export function textWidthAtPreferred(text, preferred) {
  if (!text) return 0;
  return textUnits(text) * preferred * nodeTextFit.widthFactor + nodeTextFit.horizontalPadding;
}

/**
 * Size one component from its text. An authored `size` is a hard pin and wins.
 *
 * Widths are forced even so that `x = rankCentre - width / 2` stays an integer
 * and `cx` lands exactly on the rank centre. That exactness is load-bearing:
 * `defaultFromSide` only picks top/bottom over left/right when two centres are
 * exactly equal, which is what keeps a same-rank edge routing vertically
 * instead of cutting sideways past its neighbours.
 */
export function sizeComponent(component, options) {
  if (Array.isArray(component.size) && component.size.length === 2) {
    return { width: component.size[0], height: component.size[1], pinned: true };
  }
  const floors = [
    textWidthAtPreferred(component.label, NODE_TEXT.label),
    textWidthAtPreferred(component.sublabel, NODE_TEXT.sublabel),
    textWidthAtPreferred(component.tag, NODE_TEXT.tag),
    options.minNodeW,
  ];
  const brandRail = component.brand ? 22 : 0;
  const raw = Math.max(...floors) + brandRail;
  const width = Math.min(options.maxNodeW, Math.ceil(Math.max(raw, options.minNodeW) / 2) * 2);
  return { width, height: component.tag ? options.nodeHWithTag : options.nodeH, pinned: false };
}

/** Connection label rect width, matching render-architecture.mjs exactly. */
function labelWidth(label) {
  return label ? Math.max(30, textUnits(label) * 4.8 + 10) : 0;
}

/**
 * Rank centres by longest-path relaxation over minimum separations, the same
 * shape the workflow compiler uses: collect `{from, to, minimum}` triples, then
 * push each rank right until every constraint naming it is satisfied.
 */
export function rankCentres(layers, sizes, graph, rank, options) {
  const count = layers.length;
  if (!count) return [];
  const half = (entry) => (entry.node === null ? 0 : sizes.get(graph.nodes[entry.node].id).width / 2);
  const widest = layers.map((layer) => Math.max(0, ...layer.map(half)));

  const constraints = [];
  for (let r = 1; r < count; r += 1) {
    constraints.push({ from: r - 1, to: r, minimum: Math.max(options.rankPitch, widest[r - 1] + options.rankGap + widest[r]) });
  }
  for (const edge of graph.edges) {
    const [lo, hi] = [rank[edge.from], rank[edge.to]].sort((a, b) => a - b);
    if (hi - lo !== 1) continue;
    const a = sizes.get(graph.nodes[edge.from].id).width / 2;
    const b = sizes.get(graph.nodes[edge.to].id).width / 2;
    // A label only needs its own width of clear gap while it sits on the route.
    // resolveLabels can lift it clear instead, so this is a preference the
    // width budget is allowed to drop rather than a hard minimum.
    const gap = options.ignoreLabelWidth
      ? options.rankGap
      : Math.max(options.rankGap, labelWidth(edge.label) + options.labelGap);
    constraints.push({ from: lo, to: hi, minimum: a + gap + b });
  }

  const centres = new Array(count).fill(0);
  centres[0] = options.margin + widest[0];
  for (let r = 1; r < count; r += 1) {
    centres[r] = centres[r - 1] + options.rankPitch;
    for (const c of constraints) {
      if (c.to !== r) continue;
      centres[r] = Math.max(centres[r], centres[c.from] + c.minimum);
    }
    centres[r] = Math.ceil(centres[r]);
  }
  return centres;
}

/**
 * Vertical placement: stack each rank in order, then pull connected nodes into
 * line across ranks. Exact `cy` equality is worth chasing — two boxes on the
 * same axis route as a straight two-point path, which is optimal on every
 * route-budget metric at once (no bends, no stretch, no short segments).
 */
export function rankOffsets(layers, sizes, graph, options, passes = 3) {
  const heightOf = (entry) => (entry.node === null ? 0 : sizes.get(graph.nodes[entry.node].id).height);
  const cys = layers.map((layer) => {
    let cursor = options.margin;
    return layer.map((entry) => {
      const h = entry.node === null ? options.corridor : heightOf(entry);
      const centre = cursor + h / 2;
      cursor += h + options.nodeGapY;
      return centre;
    });
  });

  const keyIndex = new Map();
  layers.forEach((layer, r) => layer.forEach((entry, i) => keyIndex.set(entry.key, [r, i])));
  const linksFor = (entry) => {
    if (entry.node === null) return [];
    const id = graph.nodes[entry.node].index;
    return graph.edges
      .filter((e) => e.from === id || e.to === id)
      .map((e) => `n${e.from === id ? e.to : e.from}`)
      .map((k) => keyIndex.get(k))
      .filter(Boolean);
  };

  const separate = (r) => {
    const layer = layers[r];
    for (let i = 1; i < layer.length; i += 1) {
      const prevH = layer[i - 1].node === null ? options.corridor : heightOf(layer[i - 1]);
      const thisH = layer[i].node === null ? options.corridor : heightOf(layer[i]);
      const floor = cys[r][i - 1] + prevH / 2 + options.nodeGapY + thisH / 2;
      if (cys[r][i] < floor) cys[r][i] = floor;
    }
  };

  for (let pass = 0; pass < passes; pass += 1) {
    for (let r = 0; r < layers.length; r += 1) {
      layers[r].forEach((entry, i) => {
        const near = linksFor(entry).map(([nr, ni]) => cys[nr][ni]);
        if (near.length) {
          near.sort((a, b) => a - b);
          const mid = near.length >> 1;
          cys[r][i] = near.length % 2 ? near[mid] : (near[mid - 1] + near[mid]) / 2;
        }
      });
      // Order is decided; alignment may not reshuffle it.
      const order = layers[r].map((_, i) => i).sort((a, b) => cys[r][a] - cys[r][b] || a - b);
      const sorted = order.map((i) => cys[r][i]);
      order.forEach((_, i) => { cys[r][i] = sorted[i]; });
      separate(r);
    }
  }

  const lift = Math.min(options.margin, ...cys.flat().map((v, i) => v)) - options.margin;
  return cys.map((layer) => layer.map((v) => Math.round(v - Math.min(0, lift))));
}



/**
 * Widest viewBox that still renders every node text at or above the readability
 * floor. The gate projects source px through `min(1, 930 / viewBoxWidth)` and
 * fails below 6, so holding sublabels at 9px buys a 1395px canvas where letting
 * them shrink to the 6px floor would cap it at 930px.
 */
export function widthBudget(components) {
  const source = components.some((c) => c.sublabel) ? NODE_TEXT.sublabel : NODE_TEXT.label;
  return Math.floor((DESKTOP_READER_DIAGRAM_WIDTH * source) / MIN_PROJECTED_NODE_TEXT_PX);
}

/** Right edge of the drawing, including the pad a boundary adds around members. */
function intrinsicWidth(arch, measured, options) {
  const padded = new Map();
  for (const boundary of Array.isArray(arch.boundaries) ? arch.boundaries : []) {
    for (const id of boundary.wraps ?? []) padded.set(id, Math.max(padded.get(id) ?? 0, boundary.pad ?? 30));
  }
  let right = 0;
  for (const [id, box] of measured) right = Math.max(right, box.x + box.width + (padded.get(id) ?? 0));
  return Math.ceil(right + options.margin);
}




/** Do two segments cross at a point interior to both? */
function properlyCross(a1, a2, b1, b2) {
  const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const d1 = side(a1, a2, b1); const d2 = side(a1, a2, b2);
  const d3 = side(b1, b2, a1); const d4 = side(b1, b2, a2);
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
}

/** Crossings between relationships that share no endpoint, over real routes. */
export function countRouteCrossings(measured, connections) {
  const { pathFor } = createRouter(measured, connections);
  const live = connections.filter((c) => measured.has(c.from) && measured.has(c.to));
  const paths = live.map((c) => pathFor(c).points);
  let crossings = 0;
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i]; const b = live[j];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      for (let m = 0; m + 1 < paths[i].length; m += 1) {
        for (let n = 0; n + 1 < paths[j].length; n += 1) {
          if (properlyCross(paths[i][m], paths[i][m + 1], paths[j][n], paths[j][n + 1])) crossings += 1;
        }
      }
    }
  }
  return crossings;
}

/**
 * Swap same-rank neighbours while that reduces real crossings.
 *
 * Ordering already minimises crossings over the layered graph, but the router
 * decides the actual polylines - it fans ports apart and takes edges around
 * obstacles - so a graph-optimal order can still draw a crossing. Showcase
 * rejects any crossing between relationships that share no endpoint, and the
 * author of an auto layout has no coordinate to fix it with, so the solver has
 * to close that gap against the geometry that will really be drawn.
 */
export function reduceCrossings(measured, connections, options, rounds = 6) {
  let best = countRouteCrossings(measured, connections);
  for (let round = 0; round < rounds && best > 0; round += 1) {
    const byRank = new Map();
    for (const [id, box] of measured) {
      const key = box.rank ?? 0;
      if (!byRank.has(key)) byRank.set(key, []);
      byRank.get(key).push(id);
    }
    let improved = false;
    for (const ids of byRank.values()) {
      ids.sort((a, b) => measured.get(a).y - measured.get(b).y);
      for (let i = 0; i + 1 < ids.length && !improved; i += 1) {
        const a = measured.get(ids[i]); const b = measured.get(ids[i + 1]);
        const trial = new Map(measured);
        // Swap the slots, not the boxes: each keeps its own height.
        const aY = b.y + b.height - a.height;
        trial.set(ids[i], { ...a, y: aY, cy: aY + a.height / 2 });
        trial.set(ids[i + 1], { ...b, y: a.y, cy: a.y + b.height / 2 });
        const score = countRouteCrossings(trial, connections);
        if (score >= best) continue;
        best = score;
        for (const [id, box] of trial) measured.set(id, box);
        enforceSeparation(measured, options);
        improved = true;
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return best;
}

/**
 * Restore the 8px minimum between components after something has moved them.
 *
 * Separation is enforced during vertical assignment, but boundary separation
 * runs afterwards and shifts whole member sets, which can push a member back
 * into a neighbour it was already clear of.
 */
export function enforceSeparation(measured, options) {
  const byRank = new Map();
  for (const [id, box] of measured) {
    const key = box.rank ?? 0;
    if (!byRank.has(key)) byRank.set(key, []);
    byRank.get(key).push(id);
  }
  for (const ids of byRank.values()) {
    ids.sort((a, b) => measured.get(a).y - measured.get(b).y || (a < b ? -1 : 1));
    for (let i = 1; i < ids.length; i += 1) {
      const prev = measured.get(ids[i - 1]);
      const box = measured.get(ids[i]);
      const floor = prev.y + prev.height + options.nodeGapY;
      if (box.y >= floor) continue;
      const delta = Math.ceil(floor - box.y);
      measured.set(ids[i], { ...box, y: box.y + delta, cy: box.cy + delta });
    }
  }
}

/**
 * Push each boundary's members clear of anything that is not one of them.
 *
 * A boundary has no coordinates: `boundaryRect` derives it from the bounding
 * box of `wraps`, and the frame then grows upward to contain a title rail that
 * is itself pushed above any component blocking it. Left alone that compounds -
 * a blocked title drags the frame up until the boundary visibly encloses
 * components it does not contain, which reads as a claim about the architecture
 * that is simply false. Every composition gate still passes, because none of
 * them measures membership.
 */
export function separateBoundaries(arch, measured, options, problems = []) {
  const PAD = 30; const RAIL_BAND = 30;
  const boundaries = Array.isArray(arch.boundaries) ? arch.boundaries : [];
  for (let round = 0; round < 3; round += 1) {
    let moved = false;
    for (const boundary of boundaries) {
      const wraps = new Set(boundary.wraps ?? []);
      const members = [...wraps].map((id) => measured.get(id)).filter(Boolean);
      if (!members.length) continue;
      const pad = boundary.pad ?? PAD;
      const left = Math.min(...members.map((m) => m.x)) - pad;
      const right = Math.max(...members.map((m) => m.x + m.width)) + pad;
      const memberTop = Math.min(...members.map((m) => m.y));

      // Anything overlapping the frame horizontally and sitting in or above the
      // title band would either be swallowed by the frame or push the title.
      let blockedTo = -Infinity;
      for (const [id, box] of measured) {
        if (wraps.has(id)) continue;
        if (box.x + box.width <= left || box.x >= right) continue;
        if (box.y >= memberTop) continue;
        blockedTo = Math.max(blockedTo, box.y + box.height);
      }
      const required = blockedTo + RAIL_BAND + options.nodeGapY;
      if (blockedTo === -Infinity || required <= memberTop) continue;
      const delta = Math.ceil(required - memberTop);
      for (const id of wraps) {
        const box = measured.get(id);
        if (!box) continue;
        measured.set(id, { ...box, y: box.y + delta, cy: box.cy + delta });
      }
      moved = true;
    }
    if (!moved) return;
  }
  problems.push(
    '[architecture/boundary-title-capacity] Boundary members could not be separated from the components '
    + 'around them within three rounds. Give the crowded boundary fewer wrapped components, or place its '
    + 'members with an authored pos.',
  );
}

/**
 * Boundary frame and title rail, mirroring boundaryRect/measureBoundaryTitle in
 * render-architecture.mjs. The solver needs these before the renderer derives
 * them, because a title rail is an obstacle a connection label must avoid and
 * the renderer only reports the collision after the fact.
 */
export function boundaryObstacles(arch, measured, viewBoxWidth) {
  const PAD = 30; const TOP_PAD = 22; const INSET = 4; const CLEARANCE = 4; const RAIL_GAP = 2;
  const boxes = [...measured.values()];
  const minimumFontSize = Math.max(6, minimumReadableSourceTextPx(viewBoxWidth) + 1e-6);
  const labelWidthAt = (label, font) => Math.max(30, textUnits(label ?? '') * font * nodeTextFit.widthFactor + 10);

  const frames = [];
  for (const boundary of Array.isArray(arch.boundaries) ? arch.boundaries : []) {
    const members = (boundary.wraps ?? []).map((id) => measured.get(id)).filter(Boolean);
    if (!members.length) continue;
    const pad = boundary.pad ?? PAD;
    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.width));
    const maxY = Math.max(...members.map((m) => m.y + m.height));
    let x = minX - pad;
    let width = maxX - minX + pad * 2;
    // expandBoundaryForReadableTitle: a frame too narrow for its own title grows.
    const required = labelWidthAt(boundary.label, minimumFontSize) + INSET * 2;
    const extra = Math.max(0, required - width);
    if (extra) { x -= extra / 2; width += extra; }
    frames.push({
      label: boundary.label, x, width, memberTop: minY,
      y: minY - Math.max(pad, TOP_PAD), height: (maxY - minY) + Math.max(pad, TOP_PAD) + 20,
    });
  }

  // layoutBoundaryTitles: smallest frame first, each title pushed up until it
  // clears every component and every title already placed.
  const placed = [];
  const ordered = frames.map((frame, index) => ({ frame, index }))
    .sort((a, b) => (a.frame.width * a.frame.height) - (b.frame.width * b.frame.height) || a.index - b.index);
  for (const { frame } of ordered) {
    const available = Math.max(0, frame.width - INSET * 2);
    const fitted = (available - 10) / Math.max(1, textUnits(frame.label ?? '') * nodeTextFit.widthFactor);
    const fontSize = Math.max(minimumFontSize, Math.min(Math.max(9, minimumFontSize), fitted));
    const height = Math.max(16, Math.ceil(fontSize + 7));
    const title = {
      x: frame.x + INSET,
      y: frame.memberTop - CLEARANCE - height,
      width: Math.min(available, labelWidthAt(frame.label, fontSize)),
      height,
    };
    for (let guard = 0; guard < frames.length + boxes.length + 1; guard += 1) {
      const blockers = [...placed, ...boxes].filter(
        (c) => title.x < c.x + c.width && title.x + title.width > c.x && rectsOverlap(title, c),
      );
      if (!blockers.length) break;
      title.y = Math.min(...blockers.map((b) => b.y - RAIL_GAP - title.height));
    }
    placed.push(title);
  }
  return placed;
}

/**
 * Offset connection labels until each one sits clear of components, boundary
 * title rails and labels already placed.
 *
 * Routing runs through the renderer's own router, so the polylines scored here
 * are the polylines that will be drawn. Connections carrying an authored label
 * control are left exactly as written - an author placement is a pin.
 */
const RAIL_MARGIN = 4;
// The renderer's own tolerance: a label may sit up to 2px inside a component.
const BOX_MARGIN = -2;
// Showcase requires 4px between a label and every route it does not own.
const LABEL_ROUTE_CLEARANCE = 4;

export function resolveLabels(arch, measured, problems = []) {
  const connections = Array.isArray(arch.connections) ? arch.connections : [];
  const { pathFor } = createRouter(measured, connections);
  const routed = connections
    .filter((relation) => measured.has(relation.from) && measured.has(relation.to))
    .map((relation, relationIndex) => ({ relation, relationIndex, points: pathFor(relation).points }));
  const viewBoxWidth = Math.max(...[...measured.values()].map((m) => m.x + m.width), 0) + 40;
  const rails = boundaryObstacles(arch, measured, viewBoxWidth);
  const boxes = [...measured.values()];
  const placed = [];
  const resolved = [];

  const rectFor = (conn, points, dy, segment) => {
    const probe = { ...conn, labelDy: (conn.labelDy ?? 0) + dy };
    if (segment !== null) probe.labelSegment = segment;
    const [lx, ly] = labelPoint(probe, points);
    const width = Math.max(30, textUnits(conn.label) * 4.8 + 10);
    return { x: lx - width / 2, y: ly - 10, width, height: 14 };
  };

  for (const [index, conn] of connections.entries()) {
    if (!conn.label) { resolved.push(conn); continue; }
    const authored = conn.labelAt || conn.labelDx !== undefined || conn.labelDy !== undefined
      || conn.labelSegment !== undefined;
    if (authored) { resolved.push(conn); placed.push(rectFor(conn, pathFor(conn).points, 0)); continue; }

    const { points } = pathFor(conn);
    // Two degrees of freedom, cheapest first: nudge perpendicular to the route,
    // and if the route bends, move to one of its other segments. A label
    // stranded on a middle segment often sits inside a node's horizontal span,
    // where no vertical nudge can free it but a different segment can.
    const nudges = [0, -16, 16, -30, 30, -44, 44, -58, 58, -72, 72];
    const segments = [null, ...Array.from({ length: Math.max(0, points.length - 2) }, (_, i) => i)];
    let chosen = null;
    for (const dy of nudges) {
      for (const segment of segments) {
        const rect = rectFor(conn, points, dy, segment);
        const hitsBox = boxes.some((b) => rectsOverlap(rect, b, BOX_MARGIN));
        // The rail geometry here mirrors the renderer rather than being read
        // back from it, so keep a margin: an approximate obstacle must be
        // treated as slightly larger than measured, never slightly smaller.
        const hitsRail = rails.some((r) => rectsOverlap(rect, r, RAIL_MARGIN));
        const hitsLabel = placed.some((l) => rectsOverlap(rect, l));
        const nearRoute = hitsBox || hitsRail || hitsLabel ? true : collectLabelRouteClearance({
          labels: [{ ...rect, relation: conn, relationIndex: index, label: conn.label }],
          routedRelations: routed,
          threshold: LABEL_ROUTE_CLEARANCE,
        }).length > 0;
        if (!hitsBox && !hitsRail && !hitsLabel && !nearRoute) { chosen = { dy, segment, rect }; break; }
      }
      if (chosen) break;
    }
    if (!chosen) {
      problems.push(
        `[architecture/auto-label-placement] Connection label "${conn.label}" (${conn.from} -> ${conn.to}) `
        + 'has no clear position along its route. Shorten the label, or set labelAt to place it by hand.',
      );
      chosen = { dy: 0, segment: null, rect: rectFor(conn, points, 0, null) };
    }
    placed.push(chosen.rect);
    if (chosen.dy === 0 && chosen.segment === null) resolved.push(conn);
    else {
      const out = { ...conn };
      if (chosen.dy !== 0) out.labelDy = chosen.dy;
      if (chosen.segment !== null) out.labelSegment = chosen.segment;
      resolved.push(out);
    }
  }
  return resolved;
}

/**
 * Plan a full architecture layout. Returns `null` for any document that is not
 * in auto mode, so callers can use it as a guard.
 */
export function autoLayout(arch, problems = []) {
  if (arch?.layout?.mode !== 'auto') return null;
  const options = autoOptions(arch);
  const components = Array.isArray(arch.components) ? arch.components : [];
  const connections = Array.isArray(arch.connections) ? arch.connections : [];

  const graph = buildGraph(components, connections);
  const rank = assignRanks(graph, breakCycles(graph), problems);
  const layers = orderRanks(graph, rank);

  const sizes = new Map(components.map((c) => [c.id, sizeComponent(c, options)]));
  const place = (opts) => {
    const centres = rankCentres(layers, sizes, graph, rank, opts);
    const offsets = rankOffsets(layers, sizes, graph, opts);
    const boxes = new Map();
    layers.forEach((layer, r) => layer.forEach((entry, i) => {
      if (entry.node === null) return;
      const component = components[entry.node];
      const size = sizes.get(component.id);
      // An authored pos is an absolute pin; the solver places around it.
      const pinned = Array.isArray(component.pos) && component.pos.length === 2;
      const x = pinned ? component.pos[0] : Math.round(centres[r] - size.width / 2);
      const y = pinned ? component.pos[1] : offsets[r][i] - Math.round(size.height / 2);
      // `id` is load-bearing: automaticPortSpread groups ports by `rect.id`, so
      // id-less boxes all hash to the same key and unrelated connections get
      // fanned apart against each other, giving the solver routes the renderer
      // will never draw.
      boxes.set(component.id, {
        id: component.id,
        x, y, width: size.width, height: size.height, cx: x + size.width / 2, cy: y + size.height / 2, rank: r,
      });
    }));
    return boxes;
  };

  // Close the rank gaps until the drawing fits its readability budget. Gaps are
  // the only slack: node widths are already the minimum that keeps their text
  // legible, so shrinking those would trade one readability failure for another.
  const budget = widthBudget(components);
  let measured = place(options);
  if (intrinsicWidth(arch, measured, options) > budget) {
    outer:
    for (const ignoreLabelWidth of [false, true]) {
      for (let gap = options.rankGap; gap >= MIN_RANK_GAP; gap -= 4) {
        const tightened = {
          ...options, ignoreLabelWidth, rankGap: gap, rankPitch: Math.min(options.rankPitch, gap + 40),
        };
        measured = place(tightened);
        if (intrinsicWidth(arch, measured, tightened) <= budget) break outer;
      }
    }
  }
  const finalWidth = intrinsicWidth(arch, measured, options);
  if (finalWidth > budget) {
    problems.push(
      `[architecture/viewbox-readability-budget] The drawing needs ${finalWidth}px of width but only `
      + `${budget}px stays legible at a 1440px desktop (node text would project below `
      + `${MIN_PROJECTED_NODE_TEXT_PX}px). Shorten the longest node labels, drop a rank by merging `
      + 'components, or split the diagram.',
    );
  }

  separateBoundaries(arch, measured, options, problems);
  enforceSeparation(measured, options);
  reduceCrossings(measured, connections, options);
  const connectionsOut = resolveLabels(arch, measured, problems);
  return { components: measured, connections: connectionsOut, rank, layers, graph, options };
}

export default { autoLayout, autoOptions, sizeComponent, textWidthAtPreferred, rankCentres, rankOffsets, resolveLabels, widthBudget, separateBoundaries, enforceSeparation, reduceCrossings, countRouteCrossings };
