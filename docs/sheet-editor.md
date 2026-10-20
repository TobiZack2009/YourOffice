# Sheet editor

`src/sheet/` (model, commands, render) and `src/app/sheet-editor.js`. Core done (Phase 4).
The formula language is in `formulas.md`; cross-table and reference features in
`references.md`. Spec §6.

## Model (`sheet/model.js`)

- `{ tables: { [id]: Table }, tableOrder, sections }`. A table has a stable id, name, canvas
  `position`, `rowCount`/`columnCount`, default `rowHeight`/`columnWidth`, sparse `cells`
  keyed `"col,row"` (0-based), `rowOverrides`/`columnOverrides`, `merges`.
- A cell holds either a literal `value` or a `formula`, never both. Computed results live
  only in the engine.
- Sizing helpers (`HEADER_*`, `columnWidthOf`, `rowHeightOf`, `tableExtent`) live here;
  `render.js` re-exports them.
- `createTable` places new tables at `{x: gap, y: bottom of the lowest table + gap}` and
  auto-suffixes duplicate names.

## Commands (`sheet/commands.js`)

`createTable`, `deleteTable` (detaches if referenced), `renameTable` (rewrites references),
`moveTable`, `setCell` (promotes `"=..."` to a formula, grows the table, clears on
null/empty), `insertRow`/`deleteRow`, `insertColumn`/`deleteColumn`,
`setRowHeight`/`setColumnWidth`, `mergeCells`/`unmergeCells` (overlap rejected),
`fillCells {source, targets[], sourceTableId?}`, `moveCells {source, to, sourceTableId?}`,
`insertCells`/`deleteCells`. Registered with `registerSheetCommands(store)`.

- `shift.js` shifts cells, overrides and merges (merges inside a deleted band are dropped,
  straddling ones clamped) and rewrites formulas, including those in other tables.
- `fillCells` tiles the source over every target (identity cells skipped, blank source
  clears, relative refs shift by the distance from the source cell, table grows to fit).
  `tileSourceFor` uses positive-modulo tiling anchored at the source's top-left. Merges are
  ignored by fill and move.
- `moveCells` clears the source, overwrites the destination and shifts the moved formulas'
  own relative refs. References elsewhere that point into the moved block follow it
  (`retargetMovedReferences`, also across tables); a target pushed off the sheet becomes
  `#REF!`. References into the overwritten destination are left alone.
- `insertCells`/`deleteCells` slide only a band (the range's columns for up/down, its rows for
  left/right). A lone reference follows its cell; a range follows only when wholly inside the
  band (insert inside grows it, delete trims it); deleted targets become `#REF!`; a range
  straddling the band edge is left alone. A merge in the way raises `CommandError`
  (`mergedCells`), as does pushing a cell past the sheet limits.

## Renderer (`sheet/render.js`)

Pure canvas -> DOM: `renderSheet` / `renderTable` / `resolveCell` / `tableExtent`. One
absolutely positioned `<table>` per table; header row/column, `colgroup` widths, row heights,
merges as `colspan`/`rowspan` with covered cells skipped, selection highlight. Interactive
renders add `.sheet-resize-handle` strips and `span.sheet-fill-handle[data-role=fill-handle]`
in the cell holding the active range's end (a merged anchor counts for its whole block).

## Editor (`app/sheet-editor.js`)

`createSheetEditor(workspace, pageId, options)`.

- **Selection** is `{tableId, anchor, focus, others[]}`: drag or shift-click for a range,
  Ctrl/Cmd+click (and drag) adds a range, all within one table. `getSelection()` returns the
  anchor, `getRange()` the active normalised rectangle, `getRanges()` all (active last).
- **Formula bar** (`parseCellInput`: numeric text -> number, `TRUE`/`FALSE` -> boolean,
  `"=..."` -> formula). It refreshes on selection change even when focused unless it holds an
  uncommitted edit (`inputDirty`), and keeps native cut/copy/paste while it has typed text.
- **In-cell editing.** A persistent `input.sheet-cell-editor` sits inside the active `td`
  (`placeCellEditor`). `refresh()` re-renders the whole canvas, so it saves caret/focus, lifts
  the input out under `suppressBlur`, and restores it. Double-click, F2 or a printable key
  starts an edit; Enter/Tab commit and move, Escape cancels, blur commits. Merged-covered
  cells fall back to the formula bar. Keyboard focus rests on the grid (`canvasWrap`,
  `focusGrid()`).
- **Keys.** Enter/Tab commit and move; arrows; shift+arrow extends; Delete clears every range;
  Ctrl/Cmd+Enter (`fillSelection`) writes the bar content into every range relative to the
  active cell; Ctrl/Cmd+D / +R fill down / right.
- **Clipboard** (editor-internal): copy then paste tiles into a selected range that is a whole
  multiple of the copied block, else pastes once at its start; cut then paste moves
  (`moveCells`).
- **`gesture` union** (`select` / `fill` / `move` / table move). Pressing an already-selected
  cell grabs that range; dragging dispatches `moveCells` by the pointer offset (clamped to the
  sheet's top-left); release without moving is a click. Fill handle drag previews by toggling
  `.is-fill-preview` / `.is-drop-preview` on the live DOM, commits on `mouseup` via
  `fillRangeTo` -> `fillCells` (dominant direction wins). Resize handles preview live and
  dispatch one `setColumnWidth` / `setRowHeight` on release (min 24 px / 16 px). Right
  mousedown is ignored so the context menu decides the selection.
- **Right-click menu**: Cut, Copy, Paste (disabled until copied), Clear, Insert and Delete
  submenus (shift cells plus row/column), Merge/Unmerge. Row/column insert and delete act on
  every line the range spans.
- **Handle.** A handle follows the selection (table when nothing is selected, range when cells
  are). Only the table handle drags (`moveTable`).
- **Errors.** Error cells show a message line under the formula bar.
- Handle API: `mergeSelection`, `unmergeSelection`, `insertRow`/`deleteRow`,
  `insertColumn`/`deleteColumn`, `addTable`, `renameSelectedTable`,
  `setSelectedRowHeight`/`setSelectedColumnWidth`.

## Ribbon

Home: Clipboard (Paste, Cut, Copy), Cells (Merge, Unmerge), History. Insert: Tables and a
disabled Reference/Embed seam (embedding into sheets is not supported; the control carries a
`disabledReason`). Layout tab: row height and column width fields (bare number inputs, apply on
change/Enter, Escape reverts).

## Not done

System-clipboard (TSV) bridge, marching-ants marker on the copied range, incremental engine
updates (the engine rebuilds per change), sheet embeds that are editable (they are static
grids elsewhere).

## Tests

`sheet-model`, `sheet-shift`, `sheet-commands`, `sheet-fill`, `sheet-cell-shift`,
`sheet-table-engine`, `sheet-render`, `app-sheet-editor`, `app-sheet-references`.
