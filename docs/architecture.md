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
- **No static tooling.** No ESLint, no `checkJs`, no TypeScript, no framework. JSDoc is
  documentation only. Tests plus the Vite build are the verification path.

## Module layout

```
src/
  core/          stable IDs, event emitter, error types (WorkspaceFormatError, CommandError)
  workspace/     schema, validation, migrations, store, built-in commands, import/export
  sheet/         formula engine and the table model/commands/render
  document/      block model, block commands, DOM renderer
  presentation/  slide model, layouts, commands, geometry, animation/slideshow logic, renderer
  references/    scope, sections, reference commands, detached store, fit rule, cross-table rewrites
  app/           shell UI, ribbon, sidebar, editors, popovers, glue
  main.js        vite entry, mounts the shell
index.html       dev/build shell; vite-plugin-singlefile bundles it into one HTML
tests/           vitest suites, named after the module they cover
```

Layering: `workspace` knows nothing about editors. Each editor registers its commands
separately (`registerDocumentCommands(store)`, `registerSheetCommands(store)`, ...), so the
workspace layer never depends on an editor. Pure logic (geometry, scope, fit, slideshow
steps) is kept apart from DOM code so it is unit-tested without events.

## Key types

JSDoc typedefs document the shapes.

- **`Workspace`** (`workspace/store.js`): runtime state mirroring the serialized shape:
  `metadata`, `pageOrder: { root: string[], [parentId]: string[] }`, `pages: { [id]: envelope }`,
  `settings`, `detached`. The page registry/hierarchy/order is separate from page content;
  type-specific content hangs off the page envelope.
- **Commands**: `dispatch(type, payload)` validates, mutates inside a transaction, bumps
  `modifiedAt`, marks dirty and emits `change` (`{kind, transactionId, label, commands, pages}`).
  Nested `transact` joins the outer one; a throw rolls back to a snapshot. Failures are
  `CommandError(message, reason)` with a machine-readable `reason`.
- **History**: per-transaction `structuredClone` snapshots. Planned upgrade to inverse
  patches when data volumes demand it.
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
