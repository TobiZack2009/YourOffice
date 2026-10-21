# Architecture

Principles, module layout, key types and the decisions that depart from the spec
(`docs/app.txt`). Area details live in the other docs; see the index in `AGENTS.md`.

## Principles

- **Model-first.** The DOM is a rendering surface, never the source of truth. All
  mutations are validated, typed commands against the in-memory workspace model.
  Renderers are pure functions of the model.
- **Stable identity.** Pages, blocks, cells, slides, objects, sections, assets and
  reference instances have generated stable IDs. Names, titles and order are never identity.
- **Transactions.** Compound operations (insert row + formula shift, etc.) run as one
  transaction. Undo/redo operates on transactions, not DOM diffs.
- **Versioned schema from day one.** Workspace JSON has `schemaVersion` and a migration
  list; validation is a separate, exported, tested function. New fields are additive.
- **Boundaries validate.** Imported data, `setPageContent` and export all run the per-type content
  validators. `ensure*Content` initialises only absent content; malformed content throws
  `CommandError(..., "corruptContent")` instead of being replaced with an empty page. Link targets
  must pass `core/url.js` `isSafeUrl`, in the validators and again in the renderers.
- **No eval.** The formula engine and expressions are parsed to ASTs.
- **Separate dependency graphs.** Data deps (formulas, references) vs rendering deps
  (views to rerender), spec §9.
- **Light tooling.** No ESLint, no framework, no TypeScript source. `npm run typecheck` runs `tsc`
  with `checkJs` over the JSDoc, non-strict. It is advisory until it is clean (see Deviations).
  Tests, the Vite build and the architecture tests are the verification path.

## Module layout

```
src/
  core/          stable IDs, event emitter, error types (WorkspaceFormatError, CommandError), `reconcile.js` (keyed child sync)
  workspace/     schema, validation, migrations, store, history, selectors, change sets, built-in commands, import/export
  sheet/         formula engine and the table model/commands/render
  document/      block model, block commands, DOM renderer
  presentation/  slide model, layouts, commands, geometry, animation/slideshow logic, renderer
  references/    scope, sections, reference commands, detached store, fit rule, cross-table rewrites
  domain/        composition root: installs every feature on a workspace, owns the full validation rules
  app/           shell UI, ribbon, sidebar, editors, popovers, glue, demo seed
  persistence/   storage adapters, autosave, restore (see persistence.md)
  boot.js        start-up flow: open storage, restore or seed, mount, wire autosave (all injectable)
  main.js        vite entry: finds #app, supplies localStorage, calls boot
index.html      dev/build shell; vite-plugin-singlefile bundles it into one HTML
tests/           vitest suites, named after the module they cover
```

Layering: `core` <- `workspace` <- `sheet | document | presentation` <- `references` <- `domain`
<- `app` <- `main`; `persistence` sits beside `app` (it needs only `core`, `workspace`, `domain`) and
is wired to it by `main`. `workspace` and `core` import nothing from the features. A bare `Workspace`
registers only the workspace commands and checks only the envelope; `domain/index.js` is the one
place that wires the rest: `installDomain(workspace)` (idempotent) registers the document, sheet,
presentation and reference commands, the reference hook and the content validators and integrity
check; `createWorkspace`, `workspaceFromJSON` and `importWorkspaceJSON` return installed
workspaces. The app and tests build workspaces through `domain`. Pure logic (geometry, scope,
fit, slideshow steps) is kept apart from DOM code so it is unit-tested without events.

`tests/architecture.test.js` scans import specifiers and enforces the table above. One known
exception: `sheet` and `references` depend on each other (formula retargeting and reference
lookup are shared); the test pins exactly which sheet files may import `references`.

Cross-cutting behaviour hangs off command registration, not hand lists:
`registerCommand(type, handler, { hot, selfManaged, registry, inline })` records whether a command is `hot`
(cannot add, move or remove structure others depend on, so hooks skip their checks),
`selfManaged` (does its own section bookkeeping) or `inline` (the typing editor already shows the
result, so a commit made only of such commands is not redrawn). The reference hook reads `commandMeta(type)`.
Page create/rename/move respell formulas that name pages from that same hook.

## Rules

The governing sentence: **the model says what is true; the session says what the user is doing;
controllers translate intent into commands; views render those answers.** The rules below follow
from it. "Enforced" names what fails when a rule is broken; unenforced rules are review items.

1. **Dependency direction.** `core` <- `workspace` <- `sheet | document | presentation` <-
   `references` <- `domain` <- `app`, with `persistence` beside `app`. Lower layers never import
   upward. Enforced: `tests/architecture.test.js`.
2. **The model says what is true.** State that must survive a reload or an undo lives in the
   workspace and changes only through commands. A command validates its payload, returns the ids it
   creates, and records what it touched (`touchPage(tx, page, entityId)`). Commands and model code
   never read the DOM, storage, the clock or `Math.random` for anything that ends up in the model.
   Enforced: model layers (everything but `render*.js`) may not reference `document`, `window`,
   `localStorage` and the like.
3. **The session says what the user is doing.** Open page, selection, zoom, tool, folds, ribbon tab
   and clipboard go in `app/session.js`, never in the workspace and never in module-level
   variables.
4. **Views render, controllers translate.** `render*.js` files are functions from model to DOM and
   never dispatch. Editors turn input events into `dispatch(type, payload, { origin })` and read
   the DOM only at that input boundary (caret, drag position).
5. **Read through selectors.** `workspace/selectors.js` is the read API for the UI.
   `getPage`/`getPages` clone and are snapshot APIs for export and tests. Editors read live
   content through `pageContent` and the non-mutating `read*Content` functions. Enforced: `src/app`
   may not call `getPage`/`getPages` (only the nested store defines its own).
6. **One change flow.** `dispatch` -> a `change` event (`pages`, `entities`, `registry`, `origin`)
   -> each editor patches itself. Nothing re-renders directly after a dispatch. Cross-cutting
   behaviour (`hot`, `selfManaged`, `registry`, `inline`) is registration metadata, not a hand list.
7. **Keyed rendering.** View caches are keyed by id and carry a signature. A view that reads other
   pages (references, expressions) has a null signature and is redrawn every pass. An element the
   user owns (focused and equal to the model, or composing) is never replaced. An inline commit
   marks its blocks stale so undo redraws them. Every new keyed view ships a node-identity test.
8. **Lifecycle.** Document listeners and timers go through a gesture scope or a `destroy`. UI
   services (notice, popover host, keyboard dispatcher) are per-mount instances, never singletons.
   Shortcuts go through `app/keyboard.js`. Model undo/redo runs only inside `data-history="model"`
   surfaces; every other editable keeps native text undo.
9. **Untrusted data is checked at the boundary.** Import, `setPageContent` and export run the full
   validators. URLs pass `isSafeUrl` in the validator and again in the renderer.
10. **Infrastructure stays behind adapters.** Storage, clock and the session backing are injected.
    `app/` never imports `persistence/`; only `boot.js` wires them. Enforced.
11. **Size.** A file over about 800 lines is split before a feature is added to it. A feature is a
    model change, commands, a renderer, a controller, tests and a doc paragraph, each in its own
    module where it fits. Enforced: line ceilings per file (the remaining oversized files are pinned at
    their current size and may only shrink).
12. **Definition of done.** Tests named after the module; `npm test` and `npm run build` green; the
    area doc and the `AGENTS.md` counts updated; for UI changes, `npm run build && npm run smoke`
    against real Chrome; any exception to these rules recorded under Deviations.

## Deviations

Known departures from the rules. Remove an entry when it is fixed; add one rather than hiding a
breach.

- `sheet` and `references` import each other (rule 1); the test pins which sheet files may.
- The reference views, inspector and timeline rebuild on every change that touches them (rule 7).
- `styles.css` is one unscoped file; styles are not split per area.
- `npm run typecheck` reports 127 errors (mostly JSDoc shapes for DOM helpers) and is not part of
  the definition of done until it is clean.

## Key types

JSDoc typedefs document the shapes.

- **`Workspace`** (`workspace/store.js`): runtime state mirroring the serialized shape:
  `metadata`, `pageOrder: { root: string[], [parentId]: string[] }`, `pages: { [id]: envelope }`,
  `settings`, `detached`. The page registry/hierarchy/order is separate from page content;
  type-specific content hangs off the page envelope.
- **Commands**: `dispatch(type, payload, { origin })` validates, mutates inside a transaction, bumps
  `modifiedAt`, marks dirty and emits `change` (`{kind, transactionId, label, commands, pages, entities, registry, origin}`); it returns the handler's result (created ids). The UI reads through `workspace/selectors.js`, not cloned pages. See `workspace.md`.
  Nested `transact` joins the outer one; a throw rolls back to a snapshot. Failures are
  `CommandError(message, reason)` with a machine-readable `reason`.
- **Session** (`app/session.js`): what the user is doing (open page, zoom, folds, ribbon tab,
  presentation view, last slide per page, logical selection per page). One store, one writer
  (`set`), serialisable, never part of the workspace. See `app-shell.md`.
- **History** (`workspace/history.js`): per-transaction whole-state snapshots (one clone per
  commit, none for undo/redo), same-key coalescing, a 200-entry cap and a saved revision that
  drives `dirty`. Inverse patches stay a possible upgrade when data volumes demand it.
- **Formula engine** (`sheet/`): `tokenize` -> `parseFormula` (AST) -> `evaluate` in a
  context; `RecalcEngine` owns the dependency graph. See `formulas.md`.
- **Document content**: `{ blockOrder, blocks, sections }`; rich text is a list of inline
  runs. **Sheet content**: sparse tables. **Presentation content**: `{ size, slideOrder, slides }`.

## Decisions that differ from the spec

- Spec §4 sketched `pageOrder` as a flat array. We use `{ root: [...], [parentId]: [...] }`
  for the nested hierarchy with ordering per parent (schema v1).
- Formula text is authoritative (spec §6.3); computed values are caches and live only in
  the engine. References are interpreted as written (`A1` in any cell means row 1,
  column 1); `$` markers are preserved for fill/copy.
- Circular references use `#CIRC!`, a documented extension since Excel and Sheets
  disagree. Centralised in `sheet/errors.js`.
- Range dependencies are tracked as rectangles and resolved by containment during dirty
  propagation (O(formulas) per change). An interval index is the planned optimisation.
- The sheet model is 0-based; `RecalcEngine` positions are 1-based (`A1` = `"1,1"`). The
  conversion lives only in `sheet/table-engine.js`.
