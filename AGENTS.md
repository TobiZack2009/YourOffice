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

### Current phase: 6 — sections, embeds and expression references (Phases 1–5 done; Phase 6 landed, polish noted below)

Directory layout (logical modules from spec §14; may split further as it grows):

```
src/
  core/        # stable IDs, event emitter, error types
  workspace/   # schema v1, validation, migrations, store, commands, history
  sheet/       # formula engine: tokenizer, parser, evaluator, functions, recalc
  document/    # block model, block commands, DOM renderer
  presentation/ # slide model, layouts, commands, geometry (pure), DOM renderer
  app/         # shell UI, ribbon, sidebar, quick find, editor glue
  main.js      # vite entry, mounts the shell
index.html     # dev/build shell; vite-plugin-singlefile bundles it into one HTML
tests/         # vitest suites mirroring src structure
```

App layout (`src/app/`): a full-height Notion-style sidebar, and a main column of
title strip (breadcrumb, undo/redo, dirty dot) → ribbon (tab strip + panel of
labelled groups) → canvas.

```
+-----------+--------------------------------------------------------+
| sidebar   | title strip: workspace > page, undo/redo, dirty dot    |
|           | ribbon:      File | Home | Insert | ... | View         |
|           |              labelled groups of large/small buttons    |
|           +--------------------------------------------------------+
|           | canvas (page header, editor)                           |
+-----------+--------------------------------------------------------+
```

- `ribbon-tabs.js` is pure data: `getTabs(pageType)` → tabs → groups → controls
  (`button | toggle | select | menu | field | color`, each with `enabled(ctx)`, `active(ctx)`,
  `disabledReason`). Adding a tab or control is a data change. `ctx` is
  `{ workspace, page, docEditor, sheetEditor, presentationEditor, shell }`; `shell` is the narrow
  `ShellApi` the shell provides (undo/redo/save/export/import/zoom/sidebar).
- `ribbon.js` renders that data and keeps `enabled`/`active` fresh via `update()`;
  the shell calls it wherever editor or workspace state changes. Buttons cancel
  `mousedown` so the editor selection survives.
- Contextual tabs: document (Home, Insert), sheet (Home, Insert), presentation
  (Home, Insert, Design, Transitions, Animations, View; Theme stays a disabled seam), File and View on everything. `data-page-type`
  on `.app` drives the accent (document blue, sheet green, presentation orange).
- `popover.js` (positioned popovers + `buildMenu`) is shared by the ribbon and the
  sidebar. `icons.js` builds inline SVG icons from the Lucide pack (`lucide` on npm, named imports
  so unused icons are tree-shaken; a few icons with no Lucide equivalent are drawn locally). `quick-find.js` is the Cmd/Ctrl+K
  overlay (`findPages` is the pure filter).
- Embedding landed in Phase 6 (see the status log). The sheet Insert tab keeps a disabled
  "Embed" seam with a `disabledReason`: embedding into sheets is not supported.

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
  - Deliberate gaps: no table drag on the canvas (positions are set by command
    only), and cross-table references remain Phase 6. (Range selection and the
    merge/unmerge UI landed with the ribbon redesign, below.)
- **UI redesign — Notion-style workspace + Office-style contextual ribbon:**
  - `shell.js` now builds sidebar + title strip + ribbon + canvas. Added breadcrumb,
    Cmd/Ctrl+K quick find, File tab (rename workspace, mark saved, export/import
    JSON via `exportWorkspaceJSON`/`importWorkspaceJSON`; `options.onImport` lets
    `main.js` remount with the imported workspace) and View tab (canvas zoom as a
    `--zoom` CSS variable, show/hide sidebar; both are shell UI state, not model).
  - `sidebar.js`: header "+" opens a type picker (`.new-page[data-type]`), row hover
    "+" creates a child page, row "..." menu (Rename / Favorite / Delete), expand
    carets (sidebar-local state), a Favorites section, a search field that opens
    quick find, SVG type icons. `create(type, parentId?)`; drag-to-nest is unchanged.
  - `setFavorite` command (undoable) writes `settings.favoritePageIds`; `deletePage`
    prunes it; `Workspace.getFavorites()` returns the ids that still exist. No schema
    version bump (`settings` is free-form; validation checks the array shape).
  - Sheet editor: range selection (`{ tableId, anchor, focus }`; drag, shift-click,
    shift+arrow). `getSelection()` still returns the anchor cell, `getRange()` the
    normalised rectangle. Merge/unmerge are now reachable from the UI, merged cells
    highlight as a unit, and the in-editor action buttons moved into the ribbon
    (the editor handle exposes `mergeSelection`, `unmergeSelection`,
    `insertRow`/`deleteRow`/`insertColumn`/`deleteColumn`, `addTable`,
    `renameSelectedTable`, `setSelectedRowHeight`/`setSelectedColumnWidth`).
    Row/column insert and delete act on every line the range spans.
  - `styles.css` rewritten around CSS variables with per-type accents.
- **UI bug-fix pass:**
  - Layout: `.app` now fills `#app` (`flex: 1`), and the page editor is the whole
    canvas (no max-width card; `.page-body` / `.sheet-editor` flex to fill it).
  - Enter never duplicates a block kind: a quote (or any non-list, non-code block)
    splits into the same block plus a new **paragraph**; Enter on an empty quote
    turns it into a paragraph. Code blocks still split into code blocks.
  - Enter on an empty list item ends the list: the item leaves as a paragraph,
    and a list with items on both sides is split into two lists around it.
  - Changing the block type with the caret in a list item (e.g. Quote) now affects
    only that item (`extractListItem`): the list is split around it, instead of
    converting the whole list and concatenating its items. Choosing List again on a
    list only flips ordered/bulleted.
- **Nesting, multi-select, headings, lists, code:**
  - **Nested blocks (model).** A list item may carry `children: string[]`: ids of
    blocks that live in `content.blocks` but not in `blockOrder`. Any block (quote,
    heading, paragraph, code, another list) can sit under a list item; a nested list
    is how items nest. `validateDocumentContent` computes reachability from
    `blockOrder` plus item children (duplicates, missing refs and orphans are
    errors). `findContainer(content, id)` returns the live id array, the parent
    `{blockId, itemId}` and index; `insertBlock` (`parent`, `newBlockId`),
    `deleteBlock` (purges descendants) and `moveBlock` are container-aware.
    New commands: `extractListItem`, `deleteListItem`, `indentListItem`,
    `outdentListItem`, `indentBlock`, `outdentBlock` (Tab / Shift+Tab). The renderer
    emits `div.item-children` inside the `li`.
  - **Lists insert correctly.** `createBlock("list")` always seeds one empty item
    (previously `items: []` left nothing to type in). `createBlock` deep-copies its
    input so callers' arrays are never shared with the store.
  - **Heading levels.** `changeBlockType` to the same type now applies the new
    `level`/`ordered` (H1 to H2 did nothing before). The ribbon's Styles group has a
    Style `select` (Paragraph / Heading 1-3, `data-action="block-style"`) plus
    Quote / Code / List toggles; the Insert tab's Heading is a menu of levels; the
    Paragraph group gains Indent / Outdent buttons.
  - **Multi-block selection.** Each block/list item is its own `contenteditable`
    host, so selection across blocks is explicit editor state (`sel = {anchor,
    focus}` over unit keys `blockId` / `blockId:itemId`, in DOM order). Triggers:
    drag across units, shift-click, Shift+Arrow at a text edge, Escape (select the
    current unit), Cmd/Ctrl+A (unit text, then all units). With a selection:
    Backspace/Delete removes the units (one transaction, keeps an empty paragraph),
    the ribbon type/mark controls apply to every unit, arrows move/extend,
    Escape/Enter return to editing. Styling: `.is-block-selected`.
  - **Code blocks are editable.** `pre.block-code` wraps `code[contenteditable]`
    (block-level, min-height, `pre-wrap`); clicking the padding focuses it. Enter
    inserts a newline (an Enter on an empty last line exits to a paragraph), Tab
    inserts two spaces, paste inserts plain text.
  - Indent/Outdent rules: a list item indents under the previous item (never the
    first); a block indents under the list directly above it; Outdent lifts a nested
    unit one level, and a top-level list item leaves its list as a paragraph. Tab is
    always swallowed in the page. `activeInfo()` exposes `canIndent`/`canOutdent`, and
    the ribbon buttons are disabled when they would do nothing.
  - Enter/Backspace respect nesting: Enter on an empty nested block or item lifts
    it; Backspace at the start of a first nested item/block lifts it, otherwise
    merges into the previous unit.
- **Sheet: table placement, multiple ranges, fill and move (Phase 4):**
  - **Placement.** `createTable` defaults to `{x: gap, y: bottom of the lowest table + gap}`,
    so new tables no longer land on top of existing ones. The sizing helpers
    (`HEADER_*`, `columnWidthOf`, `rowHeightOf`, `tableExtent`) moved into
    `sheet/model.js`; `render.js` re-exports them.
  - **`sheet/fill.js`.** `offsetFormulaReferences(text, dCol, dRow)` moves *relative*
    references (`$` pins an axis; off-sheet becomes `#REF!`; token-level, so spacing
    and strings survive), `offsetCell`, and `tileSourceFor` (positive-modulo tiling
    anchored at the source's top-left).
  - **Commands.** `fillCells {source, targets[]}` tiles the source over every target
    (identity cells skipped, blank source clears, relative refs shift by the distance
    from the source cell each target copies, table grows to fit). `moveCells {source,
    to}` clears the source, overwrites the whole destination block and shifts the
    moved formulas' own relative refs. References *elsewhere* that point at moved
    cells are not retargeted. Merges are ignored by both. Both accept `sourceTableId`.
  - **Editor.** Selection is `{tableId, anchor, focus, others[]}`: Ctrl/Cmd+click (and
    drag) adds a range, all within one table; `getRanges()` lists them (active last),
    `getRange()` is the active one. Ctrl/Cmd+Enter (`fillSelection`) writes the
    formula-bar content into the active cell and repeats it in every range, relative
    to the active cell. Delete and row-height/column-width act on every range.
    Cell clipboard (editor-internal): copy then paste tiles into a selected range
    that is a whole multiple of the copied block, else pastes once at its start; cut
    then paste moves (`moveCells`). Ctrl/Cmd+D / +R fill down / right from the top
    row / left column (a one-line range copies from the line above / left). The
    formula bar keeps native cut/copy/paste while it has typed text or a text
    selection (`inputDirty`). The formula bar now refreshes on selection change even
    when focused, unless it holds an uncommitted edit.
  - **Ribbon.** Sheet Home has Clipboard (Paste, Cut, Copy), Cells (Merge, Unmerge),
    Size and History; Insert has Tables. Fill and row/column insert/delete were
    deliberately taken off the ribbon (see the next entry). The shell re-evaluates
    the ribbon on `onSelectionChange`, which also fires when the clipboard changes.
  - Not done: a system-clipboard (TSV) bridge, marching-ants marker on the copied range.
- **Sheet: fill handle, drag-to-move, right-click menu; document right-click menu:**
  - **Fill handle.** `render.js` puts `span.sheet-fill-handle[data-role=fill-handle]` in
    the cell holding the *active* range's end (interactive renders only; a merged
    anchor counts for its whole block). Dragging it fills: the editor keeps a
    `gesture` union (`select` / `fill` / `move`), previews the target by toggling
    `.is-fill-preview` / `.is-drop-preview` on the live DOM (no re-render
    mid-drag), and commits on the document `mouseup` via `fillRangeTo` -> `fillCells`
    (dominant direction wins; up/left work; the whole filled area is selected).
  - **Drag to move.** Pressing on an already-selected cell grabs that range;
    dragging and releasing dispatches `moveCells` by the pointer offset (clamped to
    the sheet's top-left). Release without moving is a plain click. Only the range
    holding the grabbed cell moves. Right mousedown is ignored so the context menu
    decides the selection.
  - **Right-click menu** (`openContextMenu`, `contextmenu` on the canvas; selects the
    cell first unless it is already inside a range): Cut, Copy, Paste (disabled
    until something is copied), Clear, Insert cells shift right/down, Delete cells
    shift left/up, Insert/Delete row/column, Merge/Unmerge. Items keep `data-action`s.
    (Superseded by the submenu layout in the next entry.)
  - **`sheet/cell-shift.js` + `insertCells` / `deleteCells` commands.** Only a *band*
    slides (the range's columns for up/down, its rows for left/right). Formulas
    pointing into the band are retargeted: a lone reference follows its cell, a
    range follows only when wholly inside the band (an insert inside it grows it, a
    delete trims it), deleted targets become `#REF!`; a range straddling the band's
    edge is left alone. A merge in the way raises `CommandError` (`mergedCells`), as
    does pushing a cell past the sheet limits; the table grows to fit.
  - **Popover.** `createPopoverHost` gained `showAt(point, content, {class})`
    (viewport-clamped, closes on Escape / outside press). The sheet and document
    menus mount on `document.body` so view zoom does not skew `position: fixed`.
  - **Document right-click menu** (`block-editor.js`, `openContextMenu` on the
    handle). The task asked for a menu "like the one in the document editor", but
    none existed, so one was added: Cut/Copy/Paste (best effort via `execCommand` and
    `navigator.clipboard`), text marks (disabled without a selection or in code),
    Turn into (paragraph, headings, list, quote, code), Indent/Outdent, insert
    paragraph/divider below, Delete block(s). Right-clicking inside a block
    selection keeps it; elsewhere it clears the selection and activates that unit;
    outside any block the native menu is left alone (superseded below).
- **Sheet: move recalculation, in-cell editing, resize, submenus; document menu fix:**
  - **Move retargets references.** `cell-shift.js` `retargetMovedReferences(text, block,
    dCol, dRow)` (token-based; keeps spacing/strings/`$`). `moveCells` applies it to every
    formula *outside* the source rect for same-table moves: a lone ref into the moved
    block follows it; a range follows only if both ends are inside the block; a target
    pushed off the sheet becomes `#REF!`. References into the overwritten destination are
    left alone. Formulas inside the moved block keep the relative-offset behaviour.
    Engines rebuild on every change, so values recalculate. Cross-table refs: Phase 6.
  - **In-cell editing.** A persistent `input.sheet-cell-editor` is placed inside the
    active `td` (`placeCellEditor`); `refresh()` re-renders the whole canvas, so it saves
    caret/focus, lifts the input out under `suppressBlur`, and restores it. Double-click
    (`detail >= 2`), F2, or a printable key (typing over) starts an edit; Enter/Tab commit
    and move, Escape cancels, blur commits. It mirrors the formula bar both ways. Keyboard
    focus now rests on the grid (`canvasWrap`, `tabindex=-1`, `focusGrid()`), not the
    formula bar. Merged-covered cells fall back to the formula bar.
  - **Resize.** Row height / column width fields left Home for a new sheet **Layout** tab
    and are bare number inputs that apply on change/Enter (Escape reverts); no Apply
    button. Interactive renders add `.sheet-resize-handle` strips (`col-resize` /
    `row-resize`) to the headers; dragging previews live and dispatches one
    `setColumnWidth` / `setRowHeight` on release (min 24 px / 16 px).
  - **Submenus.** `popover.js` `MenuItem.submenu` -> `buildSubmenu`: a trigger showing
    only the section name and a `›`, with a flyout that opens on hover/click (flips left
    near the window edge). The sheet menu has Insert and Delete submenus (shift cells
    plus row/column); the document menu's "Turn into" is a submenu. Inner `data-action`s
    are unchanged.
  - **Document right-click outside a paragraph.** `.page-body` is a flex column and
    `.document-editor` fills it, so margin clicks reach the handler; `nearestUnitKey`
    picks the vertically nearest block (active/last block when there is no layout), so
    the custom menu appears and the native one is shown only with no blocks at all.
- **Phase 5 complete — presentation editor (spec §7):**
  - **Model (`src/presentation/model.js`).** `content = { size, slideOrder, slides }`.
    `size` (`{width, height}`, 320..7680, default 1280x720) lives on the content and is
    shared by every slide. A slide has `layout`, `background`, `transition`
    (`style` none|fade|wipe, `direction`, `duration`), `objectOrder` (z-order, bottom to
    top) and `objects`; identity (`slide_...`, `obj_...`) is separate from both orders.
    Objects: `text | shape | line | image` with x/y/width/height/rotation, fill/stroke,
    `shape` kind, `flipV` for lines, a `text` body (`runs`, fontSize, color, align,
    valign), `link`, and `src` (data URL; moves to the asset registry in Phase 7).
    `validatePresentationContent` / `ensurePresentationContent` follow the sheet pattern.
  - **Layouts (`layouts.js`).** Title, Title + content, Two columns, Blank; defined in
    fractions of the slide size, they only pre-place text objects (no placeholders).
  - **Commands (`commands.js`).** `createSlide`, `duplicateSlide`, `deleteSlide`
    (`lastSlide` refusal), `moveSlide`, `setSlideBackground`, `setSlideTransition`,
    `applyTransitionToAll`, `setSlideSize {scaleContent}` (rescales every object in the
    same transaction), `insertObject`, `updateObject`, `updateObjects`, `setObjectRuns`,
    `deleteObjects`, `duplicateObjects`, `pasteObjects`, `reorderObjects`. All are
    transactions, so undo/redo comes from the store.
  - **Geometry (`geometry.js`, pure).** `rotatedBounds`, `resizeRect` (local axes, fixed
    anchor), `rotationFrom`, `snapMove` (slide edges/centre, other objects, optional
    grid), `objectsInMarquee`, `planSlideReorder`, `fitScale`, `scaleObject`,
    `SIZE_PRESETS` (16:9, 4:3, 16:10).
  - **Render (`render.js`).** `renderSlide(slide, {size, scale})` is shared by the stage
    and the thumbnails; shapes/lines are inline SVG, text goes through `renderRuns`.
  - **Editor (`app/presentation-editor.js`).** Three panes: `slide-strip.js` (thumbnails,
    hover "+", drag reorder, right-click menu with a layout submenu, strip keyboard),
    the scaled stage, and `inspector.js` (selection-driven sections; slide background,
    transition and size when nothing is selected). A `gesture` union
    (`move | resize | rotate | marquee | draw`) previews on the live DOM and commits one
    command on mouseup; geometry lands on whole logical px. Pointer conversion uses
    `rect.width / size.width || 1`, so jsdom (zero rects) works. Text edits in place
    (double-click, F2/Enter, or typing) through a `contenteditable` committed with
    `setObjectRuns`; marks and links share `app/marks.js`. The shell holds the state that
    must survive its remount-on-undo (current slide per page, view toggles, clipboard).
  - **Ribbon.** New `kind: "color"` control (native colour input, applies on change).
    Home: clipboard, slides, text, arrange, history. Insert: text box, shape gallery,
    line, image (file picker to data URL). Design: size presets + width/height (asks
    Scale content / Keep as is), background colour, Theme seam. Transitions: style,
    direction, duration, apply to all. View: inspector, snap guides, grid snap.
  - **Scoping call.** Multi-selection supports move, delete, duplicate, arrange and X/Y
    only; resize and rotate handles are for a single selected object.
  - **Browser smoke (playwright-core driving system Chrome; throwaway scripts, not in
    `npm test`).** Move/resize/rotate/marquee, draw, in-place text with marks, context
    menus with submenus (native menu suppressed), slide add/reorder, size popover were
    all exercised. Bugs found and fixed: unrounded drag/draw geometry; an inspector
    number field re-committed on blur and swallowed the next click (the change event
    fires on blur after Enter); a heavy focus outline around the sheet canvas.
  - Deferred: slideshow playback and transition playback,
    themes, embedding slides in documents (Phase 6), image assets in the registry
    (Phase 7), resize/rotate of multi-selections.
- **Sidebar click target and Lucide icons:**
  - The whole `.page-row` / `.favorite-row` selects its page (`selectFromRow`), not just
    the title button. Clicks on the caret, `.page-actions` and the rename input are
    ignored by the row handler; double-click-to-rename and drag-and-drop are unchanged.
    Rows use `cursor: pointer`.
  - `icons.js` now maps each icon name to a Lucide icon node (named imports from
    `lucide`, so the bundle only carries what is used, about +6 kB). The `icon()` /
    `hasIcon()` API and the `icon icon-<name>` / `data-icon` attributes are unchanged.
    The letter glyph icons (B/I/U/S/H1-3) are now Lucide icons; hand-drawn nodes remain
    only for table-new, row/column delete, shift-*, fill-all, rect, bring-forward and
    send-backward. Block "Delete" in the document context menu uses `trash`.
  - Restored the page title input in the header (`pageHeader.append(titleInput)`), which
    an earlier removal of the page-kind badge had dropped along with it.
- **Presentation animations:**
  - **Model.** A slide gains `animations: { [id]: Animation }` and `animationOrder: string[]`
    (identity apart from order, like `objects`/`objectOrder`). `Animation = { id (anim_...),
    objectId, effect: appear | fade-in | slide-in | motion, trigger: click | with | after,
    delay, duration (ms), direction? (slide-in: where it comes from), path? (motion:
    `{from, to}` offsets from the resting position) }`. `createAnimation`/`validateAnimation`
    live in `model.js`; `validateSlide` tolerates slides without the fields and
    `ensurePresentationContent` backfills them (no schema bump). "After previous" is what the
    user called "before previous".
  - **Commands.** `addAnimation`, `updateAnimation` (whitelisted patch; switching effect
    adds/removes `direction`/`path`), `deleteAnimation`, `moveAnimation`. `deleteObjects`
    removes the objects' animations, `duplicateSlide` remaps animation and object ids,
    `setSlideSize` with `scaleContent` scales path offsets. Duplicating or pasting objects
    does not copy animations.
  - **Pure logic (`presentation/animation.js`).** `planTimeline` (a click starts a step; step
    0 auto-plays; `with` anchors to the previous anchor, `after` to the previous end),
    `planPreview` (steps run back to back with a 400 ms pause), `initiallyHidden` (entrance
    effects hide their object), `slideInOffset`, `effectKeyframes`. Movement uses the
    individual CSS `translate` property so it composes with the inline rotation.
  - **UI.** `animation-timeline.js` is an ordered list under the stage whose rows edit in place (Start and Effect selects, a
    Direction select for slide-in, Delay/Duration ms inputs; `effectPatch` carries the new
    effect's default duration only if the old default was untouched, a refused edit reverts the
    row). Focus is restored after the re-render each edit causes, `select()` re-marks the
    selected row without a rebuild so open dropdowns survive, and Backspace/Delete inside a
    field never deletes the animation. Shown only while the
    Animations ribbon tab is active (`View.timeline`, set by the shell from
    `ribbon.getActiveTab()` and `createRibbon(..., { onTabChange })`). Rows reorder by drag
    (`planSlideReorder`) and by up/down buttons. The stage overlay shows numbered tags, and a
    dashed line with draggable endpoints for the selected motion animation (a `path` gesture
    that commits one `updateAnimation` on mouseup). `animation-preview.js` plays the current
    slide with the Web Animations API (feature-detected; without it objects are revealed on
    schedule and motion objects park at the end), auto-advancing click steps, and restores
    the resting state. Any model change, slide switch, Escape or stage click stops it.
    The slide strip shows an `animation-badge`. The Animations tab has Animation (Appear,
    Fade in, Slide in menu, Motion path), Timing (Start, Delay, Duration, Direction), Order
    and Preview groups; Delay/Duration are in ms like the transition duration field.
  - Browser smoke (playwright-core, system Chrome): add/retime/reorder/preview, motion
    endpoint drag, tab switch hiding the timeline, no console errors.
  - **Editing from the ribbon.** The Animations tab edits animations, not only the timeline.
    The effect gallery (Appear, Fade in, Slide in menu, Motion path) *replaces* the selected
    animation's effect (`applyAnimationEffect`, via `updateAnimation` + `effectPatch`; a no-op
    when nothing changes) and highlights the current effect; with no animation selected, or one
    belonging to an object other than the selected one, it adds. A separate "Add animation" menu
    always adds. Timing gains Move X / Move Y fields (motion only; offset = `path.to - path.from`),
    and the Order group starts with an "Animations" picker menu listing every animation on the slide
    (`describeAnimations`, current one checked). `syncAnimationToSelection` makes selecting an
    object select its first animation (unless the current one already belongs to it; an empty
    selection keeps the current one), so Timing controls enable without visiting the timeline.
- **Phase 6 — sections, embeds and expression references:**
  - **Language (`src/sheet/`).** The tokenizer gives every token an `end` offset and adds `!`,
    `'quoted names'` (`''` escape) and an optional leading `=`. The parser adds a `path` node
    (`segments`, optional `address`: `Page!Table!A1:B2`) and `REF("id")`. One function table
    serves sheets and expressions: the old six plus lazy IF/IFERROR/IFNA, logic (AND OR NOT
    ISBLANK ISERROR ISNUMBER ISTEXT), math (ROUND* ABS INT MOD SQRT POWER) and text (LEN UPPER
    LOWER TRIM LEFT RIGHT MID FIND SEARCH REPLACE SUBSTITUTE TEXT INCLUDES STARTSWITH ENDSWITH).
    Values are scalars, ranges, and handles `{kind: "blocks"|"slide", sectionId}`; a 1x1 range
    collapses to a scalar and block runs coerce to plain text. Errors explain themselves:
    `sheet/errors.js` has a plain-language message and hint per code, and a derived error
    (same `code`) carries specifics such as "did you mean". Rewrites in `shift.js`,
    `cell-shift.js`, `fill.js` slice by token `end`.
  - **Scope (`src/references/scope.js`, `rewrite.js`).** Page nesting is scope nesting; a page's
    members are its tables, named sections and child pages. Bare names resolve innermost-out,
    so a section on another page needs a `Page!Name` path. Duplicate table/section names are
    auto-suffixed. Rename, page move and a name that would re-point an existing bare name rewrite
    expressions and cell formulas token by token (qualifying a path to keep the same target) in
    the same transaction.
  - **Cross-table formulas.** `Expenses!B2` works. `sheet/table-engine.js` keeps one
    workspace-wide cell-keyed dependency graph (`TableEngines` per-table API unchanged).
    `references/cross-table.js` rewrites formulas in other tables and expressions on row/column
    insert/delete, cell insert/delete and `moveCells` (the same-table guard is gone). Deleting a
    referenced table detaches it instead of producing `#REF!`.
  - **Sections and references.** `content.sections[id] = {id, name?, locator, implicit?}` on each
    page. Locators: document `{startBlockId, endBlockId}` (a contiguous sibling run), sheet
    `{tableId, range?}`, presentation `{slideId}` for one slide or `{slideId: first, slideIds: [...]}`
    for several (any set, not only neighbours; `slideLocator` builds the canonical form, ids in
    presentation order). Tables and slides get an implicit unnamed
    section when embedded (`references/catalog.js` `ensureSection`). A reference instance is
    `{id, kind: "embed"|"expression", sectionId | expression, display}` and lives as a document
    `sectionRef` block, an inline run `{text: REF_CHAR, ref}` (atomic, counts as one character),
    or a presentation `reference` object. `references/hosts.js` is the single scan of hosts.
    Commands (`references/commands.js`): `createSection`, `renameSection`, `removeSection`,
    `insertReference`, `updateReference`, `removeReference`, `setExpression`, `restoreDetached`.
    `aroundCommand` hooks capture and heal section locators around block commands, sweep the
    detached store and run the cycle check (`HOT_COMMANDS` such as typing skip them).
  - **Detached store.** `workspace.detached` holds content whose source was deleted while
    referenced (page, block, table, slide). Every reference keeps rendering it; removing the last
    reference discards it in the same transaction. `validateWorkspace` checks section/reference
    integrity and cycles on import; the field is additive, no version bump.
  - **Fit rule (`references/fit.js`, pure).** Scalars/empty/errors are inline; blocks only when it
    is one paragraph/heading/quote; tables and slides when display width <= 50% of the container.
    A breaking inline embed renders text / embed / text while the paragraph stays one block.
  - **Document UI.** `handles.js` is the shared hover handle (gutter handle on every block:
    Make section, rename, show references, remove; embed menu: go to source, remove; blocks drag as
    one transaction). `reference-picker.js` is a searchable tree with live previews;
    `expression-editor.js` is a popover with live result, plain-language error, a list of the
    referenced names with number markers and `is-ref-N` underline colours, and Insert/Apply
    disabled while invalid. `notice.js` is one `CommandError` surface for all three editors.
    Document embeds are editable in place (edits reach every copy).
  - **Sheet UI.** A handle follows the selection (table, or range when cells are selected); the
    table handle drags. Error cells show a message line under the formula bar. Sheet embeds on
    documents and slides are static grids.
  - **Presentation.** `reference` objects are standalone and move/resize like images. Inline refs
    in text objects set `autoHeight` (stored height is the minimum; `measureAutoHeights` in the
    editor sets the drawn height without dispatching). A selected reference object shows a handle
    (replace source = the slide-embed swap, edit expression, remove); double-click edits an
    expression. The editor refreshes on other pages' changes when it drew references.
    The Insert tab has a Reference group (Embed, Expression); the slide strip has a section handle.
  - **Multi-slide sections.** The slide strip selects several slides (Shift+click range from the
    anchor, Cmd/Ctrl+click toggle, Shift+Arrow extend, Cmd/Ctrl+A all; the current slide is always
    in a multi-selection and a plain click or arrow ends it). Its handle on a selected slide names
    the whole selection as one section (`createSection` with `slideLocator(ids)`); Delete removes
    the selection through `deleteSlide {slideIds}`, one command, so healing sees a single change.
    Deleting some of a section's slides shrinks its locator to the survivors; deleting all of them
    detaches the slides (sections sharing a vanished slide share one detached entry). A multi-slide
    embed draws the slides stacked, in presentation order (`.reference-slides`), and never flows
    inline. The picker lists a named multi-slide section under its presentation. Dragging in the
    strip still moves one slide.
  - **Links and trailing click (document editor).** A link is an inline mark editable like bold:
    `link-form.js` (`normalizeLinkUrl` rejects script-like schemes, bare emails become `mailto:`;
    `buildLinkForm`, `buildLinkCard`). `setLink(url, text?)` edits, inserts at a caret, removes, and
    splits partially covered anchors; clicking a link opens a card (edit / remove / open, and
    Cmd/Ctrl+click opens it), the ribbon Link button is `active` inside a link and the context menu
    has Link. Cmd/Ctrl+K is Quick Find, so it is deliberately **not** a link shortcut. Clicking
    below the last block focuses a trailing empty paragraph or appends one.
  - **One link type for pages and addresses.** The Insert tab has a single Link control (the
    separate "Page link" block menu is gone; existing `pageLink` blocks still render, and clicking
    one opens its page). The form's one field takes a web address or a page name: matching pages
    are listed under it (`link-pages`, `linkPages(workspace)`), picking one fills the field and
    defaults the text to the title (never overwriting text the user typed), and Apply/Enter on
    words that are not an address takes the first match. A page destination is the ordinary link
    mark with href `#<pageId>` (`pageIdOfLink`, `pageLinkUrl`), so it edits, removes and splits like
    any link. Its card shows the page title with a go-to button (`options.navigate`), or "Page
    removed"; Cmd/Ctrl+click goes straight to the page. The presentation editor uses the same form
    (`createLinkForm(close)`, shared by the ribbon Link button and the context menu's Link…): while
    editing text it links the selection (a page is the anchor href `#<pageId>`), otherwise it links the
    selected objects, mapping `#<pageId>` to the object link `{kind: "page", pageId}` and anything
    else to `{kind: "url"}` (`getLinkUrl` / `getLinkInfo` map back; a slide link counts as linked but
    has no address). The inspector's Link section is unchanged and is the only place to set a slide
    link.
  - **Browser smoke (playwright-core, system Chrome).** Make a section from a paragraph, embed it
    on a slide, cross-page expression (`Budget!'Q1 Budget'!D2`), bad expression blocked with an
    explanation, delete the source and the embed survives, inline expression chip in a paragraph,
    cross-table formula rewritten on table rename, `#NAME?` cell explained. No console errors.
    Found and fixed: the table name label leaking out of table embeds.
  - **Known limitations / deferred.** Sheet embedding is disabled. Drag-to-repoint outlines are
    deferred. Colours are a subset: the expression editor lists referenced names with a marker
    and underline colour, but there is no token colouring, cell outlines or point mode (AST nodes
    carry no offsets). Inline refs and slide embeds are static; edit via the source or a
    block-level document embed. Inline refs in slide text have no handle. Cycle errors carry no
    path detail. The shared engine rebuilds the whole workspace per refresh. Cell-formula to
    section cycles rely on the evaluator depth guard. A fully deleted range section is removed
    rather than detached. Arrow navigation in a host skips embed blocks. An inline embed's
    inline/break choice reads `clientWidth` at render time (0 when unmounted, so tables and
    slides break until re-rendered). A page-title ambiguity gives `#NAME?`. Multi-selection
    resize on slides is still deferred. The slide strip handle is click-only. Multi-slide sections cannot be dragged as a group.
- Test suites: `ids`, `events`, `schema`, `store`, `format`, `formula-errors`,
  `references`, `tokenizer`, `parser`, `evaluator`, `recalc`, `document-model`,
  `document-commands`, `document-render`, `sheet-model`, `sheet-shift`,
  `sheet-commands`, `sheet-fill`, `sheet-cell-shift`, `sheet-table-engine`, `sheet-render`, `app-inline`,
  `app-sidebar`, `app-block-editor`, `app-sheet-editor`, `app-shell`, `app-ribbon`,
  `app-quick-find`, `app-popover`, `document-nesting`, `presentation-model`,
  `presentation-commands`, `presentation-geometry`, `presentation-render`,
  `app-presentation-editor`, `app-marks`, `app-animations`, `presentation-animation`, plus the
  Phase 6 suites: `formula-functions`, `cross-table`, `sheet-refscan`, `references-scope`,
  `references-rewrite`, `references-catalog`, `references-commands`, `references-fit`,
  `app-references`, `app-block-references`, `app-inline-references`, `app-sheet-references`,
  `app-slide-references`, `app-presentation-references`, `app-links`, `references-multi-slide`.
  **1071 tests green across 54 files**; the single-file build inlines JS + CSS into one
  ~388 kB HTML.

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
   renderer, an interactive editor, range selection and merge UI, multi-range
   selection, fill/copy/move with relative-reference offsets. Remaining: canvas
   dragging, fill-handle / drag-to-move, incremental recalc, cross-table visual polish.
5. **Phase 5 — presentation** (done): slides on a shared, editable canvas size
   (default 1280×720), stable object IDs, text/image/shape/line, stored transitions.
   Ordered animations landed afterwards (see the status log); slideshow playback is deferred.
6. **Phase 6 — references/sections** (landed; limitations in the status log): typed source locators, reference instances,
   live cross-editor embeds, parameters, conditional visibility (small AST language),
   source-vs-instance editing, section dep cycles and invalidation.
7. **Phase 7 — persistence/interchange:** IndexedDB autosave + recovery, Markdown,
   CSV, PDF, limited Office formats.
8. **Phase 8 — standalone export:** pristine-shell single-HTML export (editable +
   read-only enforced at the command layer), asset embedding, `<script
   type="application/json">` payload with escaping, Playwright round-trip validation.

## Open design items to settle before implementation

(From spec §17 — decide with small prototypes + tests as each phase starts.)

- **Phase 4 engine mapping — settled:** one `RecalcEngine` per table, later replaced in
  Phase 6 by one workspace-wide cell-keyed graph (cross-table references work).
  `RecalcEngine` positions are 1-based (A1 = `"1,1"`); the sheet model is 0-based
  and converts in `TableEngines` only. Remaining Phase 4 work: canvas table
  dragging and incremental engine updates instead of a rebuild per change.

- Section locator shapes and range semantics (multi-block, non-contiguous cells).
- Reference/section expression grammar and how it meets the spreadsheet parser.
- Cross-table formula syntax (`Expenses!B2:B20`) — same-page vs other-page tables.
- Variable/parameter resolution orders and missing-value behaviour.
- Conditional expression language: operators, types, truthiness, errors.
- Section identity rules when source blocks split/merge/move/delete.
- Whether `#CIRC!` stays, or we adopt a standard code once Excel/Sheets behaviour is
  pinned down (currently centralised in `sheet/errors.js`).
