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

### Current phase: 4 — Sheet editor (Phases 1–3 complete; editable UI built)

Directory layout (logical modules from spec §14; may split further as it grows):

```
src/
  core/        # stable IDs, event emitter, error types
  workspace/   # schema v1, validation, migrations, store, commands, history
  sheet/       # formula engine: tokenizer, parser, evaluator, functions, recalc
  document/    # block model, block commands, DOM renderer
  app/         # shell UI, editor glue (editable documents UI built)
  main.js      # vite entry, mounts the shell
index.html     # dev/build shell; vite-plugin-singlefile bundles it into one HTML
tests/         # vitest suites mirroring src structure
```

Key types (JSDoc typedefs document the shapes; there is no static type checker):

- `Workspace` (store) — holds the runtime state, which mirrors the serialized shape:
  `metadata`, `pageOrder: { root: string[], [parentId]: string[] }`, `pages: { [id]:
  envelope }`, `settings`. The page registry/hierarchy/order is separate from page
  content. Type-specific content hangs off the page envelope per page type.
- Commands (`workspace/commands.js`, `document/commands.js`) — `dispatch(type,
  payload)` validates then mutates, wraps everything in a transaction, bumps
  `modifiedAt`, marks dirty, emits `change`. Document commands are registered
  separately so the workspace layer never depends on the document editor.
- History — undo/redo over transactions.
- Formula engine (`sheet/`) — `tokenize` → `parseFormula` (AST) → `evaluate` in a
  context; `RecalcEngine` owns the cell/dependency graph and recomputes.
- Document content — `{ blockOrder: string[], blocks: { [id]: Block } }`; rich text
  is a list of inline runs (`{ text, marks }`); `renderDocument` is a pure
  model → DOM function.

### Decisions vs spec deviations

- Spec §4 sketched `pageOrder` as a flat array; we use `pageOrder: { root: [...],
  [parentId]: [childId...] }` to represent the nested hierarchy with ordering per
  parent. Documented as schema v1.
- History uses per-transaction state snapshots (structuredClone). Planned upgrade to
  command inverse patches when data volumes demand it (tracked below).
- No ESLint, no jsconfig/tsc `checkJs` (per user). JSDoc comments are kept purely as
  documentation. Tests + the Vite build are the verification path. No TypeScript
  source, no framework.
- Formula text is authoritative (spec §6.3): computed values are caches. References
  are interpreted as written (`A1` in any cell means row 1, column 1); `$` markers
  are preserved for future fill/copy and row/column-shift behaviour.
- Circular references use the code `#CIRC!` — a deliberate, documented extension
  since Excel and Sheets disagree. Centralised in `sheet/errors.js` for easy change.
- Range dependencies are tracked as rectangles and resolved by containment during
  dirty propagation (O(formulas) per change). Fine for now; an interval index is the
  planned optimisation.

## Status log

- Scaffolding started: package.json (Vite + `vite-plugin-singlefile`, Vitest, JSDoc),
  vite config, shell, git init. Verification path: `npm test` + `npm run build`.
  Vitest runs with the jsdom environment; most suites are environment-agnostic.
- **Phase 1 complete (all 56 tests green, single-file build verified):**
  - `src/core/` — `ids.js` (stable prefixed IDs), `events.js` (pub/sub), `errors.js`
    (`WorkspaceFormatError`, `CommandError` with machine-readable `reason`).
  - `src/workspace/schema.js` — versioned `YourOffice-workspace` format, standalone
    `validateWorkspace()` (never throws; returns error list), migration registry +
    `migrateWorkspace()`, `PAGE_TYPES` = document/sheet/presentation.
  - `src/workspace/store.js` — `Workspace` class: command dispatch inside
    transactions (nested `transact` joins outer), snapshot rollback on throw,
    per-transaction snapshot undo/redo, dirty state, `change` events carrying
    `{kind, transactionId, label, commands, pages}`, plus `canUndo` / `canRedo` /
    `hasCommand` accessors used by the UI.
  - `src/workspace/commands.js` — built-in commands: `createPage`, `renamePage`,
    `deletePage` (cascade guard, refuses to orphan children), `movePage`
    (cycle-prevention: can't move under own descendant), `renameWorkspace`,
    `setPageContent` (deep-copied content on the page envelope).
  - `src/workspace/format.js` — `exportWorkspaceJSON` / `importWorkspaceJSON`,
    round-trip tested; rejects malformed/invalid input via `WorkspaceFormatError`.
  - `src/main.js` — placeholder shell wired to a real `Workspace` instance
    (replaced in the UI phase by `mountApp`).
- **Phase 2 complete — formula engine (spec §6), pure and dependency-free:**
  - `src/sheet/errors.js` — `FormulaError` values and `ERR` singletons
    (`#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#NUM!`, `#N/A`, `#CIRC!`, `#ERROR!`).
  - `src/sheet/references.js` — A1 parse/format, absolute/mixed markers, `refKey`,
    range normalisation + containment.
  - `src/sheet/tokenizer.js` — numbers (incl. exponent), strings ("" escapes),
    booleans, error literals, words (refs/names), operators, punctuation; `FormulaSyntaxError`
    with positions.
  - `src/sheet/parser.js` — recursive-descent precedence-climbing AST. Excel
    precedence (`-2^2 = 4`), right-associative `^`, ranges, calls with omitted args,
    comparisons.
  - `src/sheet/values.js` — coercion (`toNumber/toText/toBoolean`), type-ordered
    comparison, number formatting.
  - `src/sheet/functions.js` — SUM, AVERAGE, MIN, MAX, COUNT, CONCAT; Excel
    range-vs-scalar coercion rules.
  - `src/sheet/evaluator.js` — pure AST evaluator; lazy `IF`; error propagation;
    overflow → `#NUM!`; `displayValue`.
  - `src/sheet/recalc.js` — `RecalcEngine`: forward/reverse dependency graph, range
    rectangles, dirty-queue incremental recalculation, topological evaluation,
    cycle detection (self, two-node, self-containing range, downstream).
- **Phase 3 complete — document editor (spec §5):**
  - `src/document/model.js` — block types (paragraph, heading, list, quote, code,
    divider, image, pageLink + placeholder sectionRef/sheetEmbed/slideRef), inline
    runs with marks, `createBlock`, `validateBlock`, `validateDocumentContent`,
    `ensureDocumentContent`. Content shape `{ blockOrder, blocks }` (order ≠ identity).
  - `src/document/commands.js` — `insertBlock` (index/after/before), `updateBlock`,
    `setBlockRuns`, `deleteBlock`, `moveBlock`, `addListItem`, `changeBlockType`
    (content-converting type switch that preserves block identity); registered via
    `registerDocumentCommands(store)`.
  - `src/document/render.js` — pure model → DOM: `renderDocument`, `renderBlock`,
    `renderRuns`; textContent only (no HTML injection); `data-block-id` for future
    editing glue; page-title/asset-url resolvers passed in as options.
- **Editable UI (first half of the app layer, `src/app/`):**
  - `dom.js` — `h` / `clear` / `fragment` element helpers (attributes, `on*`
    handlers, dataset; text via textContent only).
  - `inline.js` — the only place mapping HTML ↔ marks: `parseInlineRuns`,
    `mergeRuns`, `runsEqual`, `runsToPlainText`, `normalizeText` (nbsp → space,
    `<br>` → `"\n"`; b/strong→bold, i/em→italic, u→underline, s/strike/del→strike,
    code, a[href]→link).
  - `sidebar.js` — page tree with selection, inline rename (double-click), delete,
    drag-to-nest. `planDrop(workspace, dragId, target)` is a pure function
    (`{type: "onto" | "before" | "after" | "root"}` → `{newParentId, index}`) so
    drop rules including cycle prevention are unit-tested without drag events.
  - `block-editor.js` — `createDocumentEditor(workspace, pageId, options)`. Each
    run-capable block is its own `contenteditable` element; structure changes
    (Enter split, Backspace merge/delete, list item split/exit, arrow navigation)
    are handled by dispatching commands and re-rendering, never by letting the
    browser restructure the DOM. Typing commits on `input` via `setBlockRuns` /
    `updateBlock`; the store `change` handler **skips re-rendering for inline-only
    commits** (`setBlockRuns`/`updateBlock`), which is what keeps the caret stable.
    Marks use `document.execCommand` when available, else a manual Range wrap/unwrap
    (jsdom path). Exposes `activeInfo`, `setActiveType`, `insertAfterActive`,
    `insertAtEnd`, `toggleMark`, `setLink`, `focusBlock`, `destroy`.
  - `shell.js` — `mountApp(root, workspace, options)`: sidebar + toolbar (block
    types, marks, link popover, insert menu with page links, undo/redo, dirty dot)
    + canvas (page-title header, document editor, or Phase 4/5 stub for sheet and
    presentation pages). Owns page selection, recreates the editor per page, and
    maps sidebar actions to workspace commands (create seeds a starter paragraph).
  - `styles.css` — Numbers/Pages-inspired light theme (accent `#007aff`, sidebar
    `#f5f5f7`); imported by `src/main.js`.
  - Deliberate gaps: no persistence yet (in-memory + dirty dot; Cmd/Ctrl+S just
    calls `markSaved`), image insert is omitted because the asset registry lands in
    Phase 7, and sheet/presentation pages render a stub.
  - `src/main.js` — seeds a welcome document and calls `mountApp`.
- **Phase 4 in progress — sheet editor (spec §6):**
  - `src/sheet/model.js` — sparse table model: `{ tables: { [id]: Table }, tableOrder }`;
    each table carries stable id, name, canvas `position`, `rowCount`/`columnCount`,
    default `rowHeight`/`columnWidth`, sparse `cells` keyed `"col,row"` (0-based,
    matching the engine), `rowOverrides`/`columnOverrides`, `merges`, and
    `validateTable` / `validateSheetContent` / `createTable` / `ensureSheetContent`.
    A cell holds either a literal `value` or a `formula` (never both) — computed
    results live only in the engine (spec §6.3).
  - `src/sheet/shift.js` — index-shift algebra for row/column insert/delete:
    `shiftRef` (absolute markers do **not** exempt a reference — Excel shifts them
    on structural edits), `shiftFormulaReferences` (token-level rewrite that
    preserves the user's spacing/strings and emits `#REF!` for deleted targets),
    `shiftCells` / `shiftOverrides` / `shiftMerges` (merges inside a deleted band
    are dropped, straddling ones clamped).
  - `src/sheet/commands.js` — `createTable`, `deleteTable`, `renameTable`,
    `moveTable`, `setCell` (promotes `"=…"` strings to formulas, grows the table to
    fit a position, clears on null/empty), `insertRow`/`deleteRow`,
    `insertColumn`/`deleteColumn`, `setRowHeight`/`setColumnWidth`,
    `mergeCells`/`unmergeCells` (overlap rejected). Registered with
    `registerSheetCommands(store)`.
  - `src/sheet/table-engine.js` — `TableEngines`: **one `RecalcEngine` per table**
    (the Phase 4 decision). The engine speaks 1-based A1 positions; the model is
    0-based, and that conversion lives only here. Engines are rebuilt from the
    sparse store on change (correct over clever; incremental deltas are the
    planned optimisation, tracked below).
  - `src/sheet/render.js` — pure canvas → DOM: `renderSheet` / `renderTable` /
    `resolveCell` / `tableExtent` / `columnWidthOf` / `rowHeightOf`. One
    absolutely-positioned `<table>` per table, header row/column, `colgroup`
    widths, row heights, merges as `colspan`/`rowspan` with covered cells skipped,
    selection highlight, and a "New table"/row/column action bar.
  - `src/app/sheet-editor.js` — `createSheetEditor(workspace, pageId, options)`:
    cell selection (mousedown), formula bar (`parseCellInput` turns numeric text
    into numbers, `TRUE`/`FALSE` into booleans, `"=…"` into formulas), Enter/Tab
    commit-and-move, arrow/Delete keys, row/column insert/delete at the selection,
    and Add table. Sheet pages no longer render a stub; only presentations do.
  - Deliberate gaps: no range selection (so the `mergeCells`/`unmergeCells`
    commands and merge rendering are not yet reachable from the UI), no table drag
    on the canvas (positions are set by command only), and cross-table references
    remain Phase 6.
- Test suites: `ids`, `events`, `schema`, `store`, `format`, `formula-errors`,
  `references`, `tokenizer`, `parser`, `evaluator`, `recalc`, `document-model`,
  `document-commands`, `document-render`, `sheet-model`, `sheet-shift`,
  `sheet-commands`, `sheet-table-engine`, `sheet-render`, `app-inline`,
  `app-sidebar`, `app-block-editor`, `app-sheet-editor`, `app-shell`.
  **347 tests green across 24 files**; the single-file build inlines JS + CSS into
  one ~95 kB HTML.

## Roadmap (from spec §16, reordered to land testable foundations first)

1. **Phase 1 — workspace foundation** (done): versioned JSON schema, stable
   IDs, command bus, transactions, undo/redo, dirty state, JSON import/export.
2. **Phase 2 — formula engine** (done): tokenizer, parser →
   AST, evaluator, dependency graph, incremental recalc, cycle detection, A1/absolute/
   mixed refs, SUM/IF/AVERAGE/MIN/MAX/COUNT, Excel error values.
3. **Phase 3 — document editor** (done): ordered blocks, rich text runs, page links,
   images, pure DOM renderer. Block export still outstanding.
4. **Phase 4 — sheet editor** (in progress — core landed): Numbers-style canvas,
   independent tables, sparse storage, row/col ops wired to the engine, table
   renderer and an interactive editor. Remaining: range selection + merge UI,
   canvas dragging, incremental recalc, cross-table visual polish.
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

- **Phase 4 engine mapping — settled:** one `RecalcEngine` per table, with
  cross-table references (`Expenses!B2`) deferred to Phase 6 name resolution.
  `RecalcEngine` positions are 1-based (A1 = `"1,1"`); the sheet model is 0-based
  and converts in `TableEngines` only. Remaining Phase 4 work: range selection so
  merges are reachable from the UI, canvas table dragging, and incremental engine
  updates instead of a rebuild per change.

- Section locator shapes and range semantics (multi-block, non-contiguous cells).
- Reference/section expression grammar and how it meets the spreadsheet parser.
- Cross-table formula syntax (`Expenses!B2:B20`) — same-page vs other-page tables.
- Variable/parameter resolution orders and missing-value behaviour.
- Conditional expression language: operators, types, truthiness, errors.
- Section identity rules when source blocks split/merge/move/delete.
- Whether `#CIRC!` stays, or we adopt a standard code once Excel/Sheets behaviour is
  pinned down (currently centralised in `sheet/errors.js`).
