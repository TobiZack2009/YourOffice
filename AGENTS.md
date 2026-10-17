# AGENTS.md

This file is the running architecture record for YourOffice. It documents what the
application is, how the code is structured, what is being worked on, and what comes
next. Update it as work proceeds — do not let it drift from reality.

## Product

YourOffice is a local-first, privacy-focused office suite: documents, spreadsheets,
and presentations sharing one workspace, one page hierarchy, one asset registry, one
history system, and one cross-editor reference system. Distributable as a single
standalone HTML file (editable or read-only), no backend, no network required.

Full product/technical spec: `app.txt` (source of truth for requirements).

## Architecture

### Principles

- **Model-first.** The DOM is a rendering surface, never the source of truth. All
  mutations are validated, typed commands against the in-memory workspace model.
  Renderers are pure functions of the model.
- **Stable identity.** Pages, blocks, cells, slides, objects, sections, assets and
  reference instances have generated stable IDs. Names, titles, and order are never
  identity.
- **Transactions.** Compound operations (insert row + formula shift, etc.) run as one
  transaction. Undo/redo operates on transactions, not DOM diffs.
- **Versioned schema from day one.** Workspace JSON has `schemaVersion` and a
  migration list; validation is a separate, exported, tested function.
- **No eval.** Formula engine and conditional expressions are parsed to ASTs.
- **Separate dependency graphs.** Data deps (formulas, variables) vs rendering deps
  (views to rerender) — spec §9.

### Current phase: 1 — Workspace foundation

Directory layout (logical modules from spec §14; may split further as grown):

```
src/
  core/        # stable IDs, event emitter, error types
  workspace/   # schema v1, validation, migrations, store, commands, history
  app/         # shell UI, editor glue (later phases)
src/
  main.js      # vite entry, minimal placeholder shell for now
index.html     # dev/build shell; vite-plugin-singlefile bundles it into one HTML
tests/         # vitest suites mirroring src structure
```

Key types (JSDoc typedefs document the shapes; there is no static type checker):

- `Workspace` (store) — holds the runtime state, which mirrors the serialized shape:
  `metadata`, `pageOrder: { root: string[], [parentId]: string[] }`, `pages: { [id]:
  envelope }`, `settings`. The page registry/hierarchy/order is separate from page
  content. Type-specific content will hang off the page envelope per page type.
- Commands (`workspace/commands.js`) — `dispatch(type, payload)` validates then
  mutates, wraps everything in a transaction, records inverse info for history,
  bumps `modifiedAt`, marks dirty, emits `change`.
- History — undo/redo over transactions.

### Decisions vs spec deviations

- Spec §4 sketched `pageOrder` as a flat array; we use `pageOrder: { root: [...],
  [parentId]: [childId...] }` to represent the nested hierarchy with ordering per
  parent. Documented as schema v1.
- Phase-1 history uses per-transaction state snapshots (structuredClone). Planned
  upgrade to command inverse patches when data volumes demand it (tracked below).
- No ESLint, no jsconfig/tsc `checkJs` (per user). JSDoc comments are kept purely as
  documentation. Tests + the Vite build are the verification path. No TypeScript
  source, no framework.

## Status log

- Scaffolding started: package.json (Vite, Vitest, JSDoc/checkJs), vite config with
  `vite-plugin-singlefile`, jsconfig, placeholder shell, git init.

## Roadmap (from spec §16, reordered to land testable foundations first)

1. **Phase 1 — workspace foundation** (in progress): versioned JSON schema, stable
   IDs, command bus, transactions, undo/redo, dirty state, JSON import/export.
2. **Phase 2 — formula engine** (pulled ahead of the sheet UI): tokenizer, parser →
   AST, evaluator, dependency graph, incremental recalc, cycle detection, A1/absolute/
   mixed refs, SUM/IF/AVERAGE/MIN/MAX/COUNT, Excel error values. Largest pure-test
   surface; build it before UI exists.
3. **Phase 3 — document editor:** ordered blocks, rich text, page links, images,
   block export.
4. **Phase 4 — sheet editor:** Numbers-style canvas, independent tables, sparse
   storage, row/col ops wired to the engine.
5. **Phase 5 — presentation:** 1280×720 slides, stable object IDs, text/image/shape/
   line, transitions, ordered animations.
6. **Phase 6 — references/sections:** typed source locators, reference instances,
   live cross-editor embeds, parameters, conditional visibility (small AST language),
   source-vs-instance editing, section dep cycles and invalidation.
7. **Phase 7 — persistence/interchange:** IndexedDB autosave + recovery, Markdown,
   CSV, PDF, limited Office formats.
8. **Phase 8 — standalone export:** pristine-shell single-HTML export (editable +
   read-only enforced at the command layer), asset embedding, `<script
   type="application/json">` payload with escaping, Playwright round-trip validation.

## Open design items to settle before implementation

(From spec §17 — decide with small prototypes + tests as each phase starts.)

- Section locator shapes and range semantics (multi-block, non-contiguous cells).
- Reference/section expression grammar and how it meets the spreadsheet parser.
- Cross-table formula syntax (`Expenses!B2:B20`) — same-page vs other-page tables.
- Variable/parameter resolution orders and missing-value behaviour.
- Conditional expression language: operators, types, truthiness, errors.
- Section identity rules when source blocks split/merge/move/delete.
