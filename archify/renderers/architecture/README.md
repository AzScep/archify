# Architecture Renderer

Components, boundaries and connections on a free coordinate plane. See
[`../../schemas/architecture.schema.json`](../../schemas/architecture.schema.json) for the
field list; this file documents only what the schema cannot state — which
placement mode owns a coordinate, and what each one guarantees.

## Layout contracts

Three modes. `layout` is optional; omitting it selects free placement.

| Mode | `layout` | Who owns coordinates |
|---|---|---|
| **Free** | omitted | The author. Every component needs `pos`. |
| **Grid** | `{ "mode": "grid" }` | Fixed cell arithmetic over `row`/`col`. Not a layout engine — see [`grid.mjs`](grid.mjs). |
| **Auto** | `{ "mode": "auto" }` | The solver. No coordinate is required anywhere. |

Modes never blend. `resolveComponentPos` in [`grid.mjs`](grid.mjs) resolves `pos`
first in every mode, so a free document renders identically whatever else is
added around it, and an authored `pos` stays an absolute pin under auto.

### Free and grid

Unchanged, and deliberately so: [`../../test/golden.mjs`](../../test/golden.mjs)
byte-compares every checked-in example, which is what proves a solver change
cannot reach a hand-placed diagram.

### Auto

Implemented in [`auto-layout.mjs`](auto-layout.mjs), with rank and order
planning split into [`auto-layout-ranks.mjs`](auto-layout-ranks.mjs) because that
half is pure graph code with no pixel in it. Worked example:
[`../../examples/auto-layout.architecture.json`](../../examples/auto-layout.architecture.json).

Stages, in order:

1. **Size** each node from its text, rather than shrinking text to fit a fixed
   box. This is the load-bearing one: holding sublabels at their preferred 9px
   instead of the 6px floor raises the width a diagram may occupy from 930px to
   1395px, because the desktop readability gate projects source px through
   `min(1, 930 / viewBoxWidth)`. See [`../shared/desktop-readability.mjs`](../shared/desktop-readability.mjs).
2. **Rank** by longest path over the acyclic remainder, then tighten so a
   late-feeding source is not parked at rank 0. Cycles are broken by DFS; a back
   edge is demoted for ranking only and still drawn where the author pointed it.
3. **Order** within each rank by median sweeps, over a graph expanded with a
   stand-in for every rank a long edge crosses.
4. **Place**, then close rank gaps if the drawing exceeds its width budget.
5. **Repair**: separate boundary members from non-members, restore the 8px
   minimum, swap same-rank neighbours while that lowers real crossings,
   normalise to the top margin.
6. **Resolve labels** against the real router, and drop route hints the solver
   has invalidated.

**Widths are even on purpose.** With integer rank centres that keeps `cx` exact,
and `defaultFromSide` ([`../shared/geometry.mjs`](../shared/geometry.mjs)) only
prefers top/bottom over left/right at exact equality — which is what keeps a
same-rank edge routing vertically instead of cutting past its neighbours.

**Measured boxes carry `id`.** `automaticPortSpread` groups ports by `rect.id`;
id-less boxes hash alike and fan unrelated connections apart, so the solver would
score routes the renderer never draws.

### Hints

All optional, all placement-only. A document with none still lays out.

| Hint | Effect |
|---|---|
| `pos` | Absolute pin. The solver places around it. |
| `size` | Absolute pin. Auto-sizing is skipped for that node. |
| `rank` | Pins the layer. A pin contradicting edge direction is reported, never silently drawn. |
| `group` | Keeps members adjacent within their rank. |
| `side` | `top` / `bottom` lifts a node off the main rail. Bands never interleave, so a hint always beats the barycenter. |
| `layout.returnLane` | Pins which side return paths loop along. Unset, both are solved and the one with fewer real crossings wins. |

`route: "straight"` is demoted to automatic when the solver did not align the two
boxes it was written against. It is honoured before any candidate is generated
([`routing.mjs`](routing.mjs)), so under invented coordinates it would draw a
diagonal that nothing downstream can repair. `orthogonal-h` and `orthogonal-v`
are left alone — axis-aligned from any placement, so unlovely at worst.

## Routing

Extracted to [`routing.mjs`](routing.mjs) as `createRouter(components, connections)`
so the same router can route a hypothetical scene, not only the one a render pass
builds. The solver needs that: every composition gate it must satisfy — corridors,
border runs, route rhythm, label clearance, crossings — is defined over routed
geometry, so scoring an approximation would approve layouts the renderer rejects.

The router honours explicit geometry verbatim and, when no candidate is feasible,
returns a knowingly-bad route so validation reports the real obstacle. Both
properties depend on it never second-guessing what it was told, which is why hint
demotion lives in the solver instead.

## What the gates do not measure

Every check is listed in [`../../scripts/check-render-output.mjs`](../../scripts/check-render-output.mjs).
Three defects found during development passed all nine artifact checks with zero
warnings, because nothing measures them:

- a boundary frame enclosing a component it does not wrap — no gate measures membership;
- the drawing drifting off its top margin — no gate measures whitespace;
- a route hint quietly producing a diagonal — reported only as an arrow that is not orthogonal, never as the stale hint it was.

Each is now held by a test in
[`../../test/architecture-auto-layout.test.mjs`](../../test/architecture-auto-layout.test.mjs).
A passing receipt is strong evidence, not proof; look at the render.

## Not implemented

`layout.flow` accepts only `lr`. Rank wrapping when the width budget is exceeded,
and per-edge channel assignment within a rank gap, are absent — the budget is
reported as a diagnostic instead. A rank-gap channel reservation was written and
removed: it bought no passes across the example corpus while spending width, the
scarcest resource under the readability budget.
