# Document editor

`src/document/` (model, commands, renderer) and `src/app/block-editor.js`, `inline.js`,
`link-form.js`, `marks.js`. Done (Phase 3). Spec §5.

## Model (`document/model.js`)

- Content is `{ blockOrder, blocks, sections }`. Order is not identity.
- Block types: paragraph, heading, list, quote, code, divider, image, pageLink (legacy,
  still rendered), and the reference types `sectionRef` (embed), plus inline `{ref}` runs.
  Sheet and slide embeds are `sectionRef` blocks too (the old `sheetEmbed` / `slideRef`
  placeholders are gone).
- Rich text is a list of inline runs `{ text, marks }`; marks are bold, italic, underline,
  strike, code, link. A ref run is `{ text: REF_CHAR, ref }`, atomic, one character.
- Nested blocks: a list item may carry `children: string[]`, ids of blocks that live in
  `content.blocks` but not in `blockOrder`. Any block can sit under a list item; a nested list
  is how items nest. `validateDocumentContent` computes reachability from `blockOrder` plus item
  children (duplicates, missing refs and orphans are errors). `findContainer(content, id)`
  returns the live id array, the parent `{blockId, itemId}` and the index.
- `createBlock` deep-copies its input; `createBlock("list")` seeds one empty item.

## Commands (`document/commands.js`)

`insertBlock` (index/after/before, `parent`, `newBlockId`), `updateBlock`, `setBlockRuns`,
`deleteBlock` (purges descendants), `moveBlock`, `addListItem`, `changeBlockType`
(content-converting, preserves identity; the same type applies new `level`/`ordered`),
`extractListItem`, `deleteListItem`, `indentListItem`, `outdentListItem`, `indentBlock`,
`outdentBlock`. Container-aware throughout. Registered via `registerDocumentCommands(store)`.

## Renderer (`document/render.js`)

Pure model -> DOM: `renderDocument`, `renderBlock`, `renderRuns`. `textContent` only (no HTML
injection), `data-block-id` for editing glue, page-title/asset-url resolvers via options.
Lists emit `div.item-children` inside the `li`. Embeds render through the same block renderer
pointed at the source (or detached) content.

## Inline helpers (`app/inline.js`)

The only place mapping HTML <-> marks: `parseInlineRuns`, `mergeRuns`, `runsEqual`,
`runsToPlainText`, `normalizeText` (nbsp -> space, `<br>` -> `"\n"`; b/strong, i/em, u,
s/strike/del, code, a[href]). Ref runs are atomic.

## Editor (`app/block-editor.js`)

`createDocumentEditor(workspace, pageId, options)`.

The editor is a kernel (`ed`: state accessors plus shared operations) built in `block-editor.js`,
which also owns the `change` subscription and the returned handle. The behaviour lives in modules
that each take the kernel: `block-view.js` (keyed drawing), `block-input.js` (DOM events),
`block-structure.js` (Enter/Backspace/Tab), `block-selection-ops.js` (actions on selected units),
`block-selection-io.js` (capture/restore in model terms), `block-unit-selection.js` (the unit
selection's state and painting), `block-clipboard.js` (copy, cut, paste), `block-toolbar.js` (ribbon commands),
`block-links.js` (link form and card), `block-references.js` (gutter handle, block drag, sections,
embeds, expressions), `block-context-menu.js`. Pure helpers: `block-caret.js` (DOM caret),
`block-marks.js` (wrapping marks), `block-runs.js` (splitting runs), `block-fragment.js` (clipboard
fragments: slice, plan, plain text; no DOM), `nested-store.js` (store view
for editors embedded in list items and sections).

- Each run-capable block or list item is its own `contenteditable`. Structure changes (Enter
  split, Backspace merge/delete, list item split/exit, arrow navigation) dispatch commands and
  re-render; the browser never restructures the DOM.
- Rendering is keyed by block id: a block whose data (and nested list children) is unchanged
  keeps its element, and blocks are reconciled in place. A block the user owns -- composing
  (`compositionstart..end`), or focused and already showing what the model says -- is never
  replaced. An inline commit marks the blocks it touched as stale (the DOM, not the model they
  were drawn from, is the truth), so undoing typing redraws them. Page-link blocks are redrawn on every pass because they read other pages. Section-embed and
  inline-reference blocks keep their frame element (`reference-view.js`) and swap a body only when it differs.
- Typing commits on `input` via `setBlockRuns` / `updateBlock`. The store `change` handler
  skips re-rendering for inline-only commits, which keeps the caret stable.
- Marks use `document.execCommand` when available, else a manual Range wrap/unwrap (jsdom).
- Handle exposes `activeInfo`, `setActiveType`, `insertAfterActive`, `insertAtEnd`,
  `toggleMark`, `setLink`, `focusBlock`, `destroy`.
- **Enter rules.** A non-list, non-code block splits into the same block plus a new
  paragraph; Enter on an empty quote becomes a paragraph. Code blocks split into code blocks
  (Enter on an empty last line exits). Enter on an empty list item ends the list (a list with
  items on both sides is split around it). Enter on an empty nested block or item lifts it.
- **Type change in a list.** `extractListItem` splits the list around the item so only that
  item changes; choosing List on a list only flips ordered/bulleted.
- **Code blocks.** `pre.block-code` wraps `code[contenteditable]`; Enter inserts a newline,
  Tab two spaces, paste is plain text.
- **Indent/outdent.** A list item indents under the previous item (never the first); a block
  indents under the list directly above; outdent lifts a nested unit one level and a
  top-level item leaves its list as a paragraph. Tab is always swallowed. `activeInfo()`
  exposes `canIndent`/`canOutdent`. Backspace at the start of a first nested unit lifts it.
- **Multi-block selection.** Selection across blocks is explicit state
  `sel = {anchor, focus, anchorOffset?, focusOffset?}` over unit keys `blockId` / `blockId:itemId`
  in DOM order, kept in `block-unit-selection.js`. Because a native selection cannot span
  several `contenteditable`s, a drag from one text unit into another selects the text from the
  press point to the end of the first unit, every unit between, and the start of the last unit to
  the pointer. The offsets (model-text offsets, a reference counting as one character) make the
  two end units *partial*; units without text, and units with no offset, are whole. `spans()`
  reports each unit as `{key, start, end, length, whole}`. Offsets come from
  `offsetAtPoint` (`caretPositionFromPoint`/`caretRangeFromPoint`); without that API (jsdom) a
  drag selects whole units. Whole units are painted with `.is-block-selected`, partial text with
  the CSS Custom Highlight API (`::highlight(block-selection)`), falling back to the class on the
  whole unit. Triggers: drag, shift-click, Shift+Arrow at a text edge, Escape (select current
  unit), Cmd/Ctrl+A (unit text, then all). Dragging back into the unit where the press landed
  returns to an ordinary text selection. With a selection: Backspace/Delete removes the covered
  range (one transaction: whole units go, the ends are trimmed, and two partial text ends are
  joined into the first; an empty document keeps a paragraph); a printable key over a selection
  that cuts into text replaces the range with the character; ribbon type controls apply to every
  unit; mark controls and links restyle only the covered range of the end units; arrows move or
  extend; Escape/Enter return to editing. The selection is captured and restored with its
  offsets (`selection.js`).
- **Clipboard** (`block-clipboard.js`). Block selection clears the native selection, so the
  editor answers `copy`/`cut`/`paste` itself. A copy writes `text/plain`, `text/html` (the
  rendered blocks without editor attributes) and a private JSON fragment
  (`application/x-youroffice-blocks`: the selected blocks with partial end text, plus selected
  nested blocks). Cut is copy plus the range delete. Paste reads the fragment (new block and item
  ids, marks kept) or, failing that, plain text (one paragraph per non-empty line; HTML from other
  apps is read as its plain text). A single text block pastes inline at the caret; several blocks
  split the paragraph around the caret; an empty paragraph is replaced; pasting over a selection
  replaces it. Each is one undo step. A paste inside a code block is left to the code handler. A
  text-only selection without block selection is copied by the browser. The context menu uses
  the same code: Copy/Cut run `execCommand`, which fires the events, and Paste reads the system
  clipboard text and restores the last copy's structure when the text matches.
- **Trailing click.** Clicking below the last block focuses a trailing empty paragraph or
  appends one.
- **Right-click menu** (`openContextMenu`): Cut/Copy/Paste, marks (disabled
  without a selection or in code), Turn into (submenu), Indent/Outdent, Link, Insert, insert
  paragraph/divider below, Delete block(s). Right-clicking inside a selection keeps it; outside
  it clears the selection and activates that unit. `nearestUnitKey` picks the vertically
  nearest block so margin clicks work; the native menu shows only with no blocks at all.
- Embeds and sections: see `references.md`.

## Links

A link is an inline mark edited like bold. `link-form.js`: `normalizeLinkUrl` (rejects
script-like schemes; bare emails become `mailto:`), `buildLinkForm`, `buildLinkCard`.
`setLink(url, text?)` edits, inserts at a caret, removes, and splits partially covered
anchors. Clicking a link opens a card (edit / remove / open; Cmd/Ctrl+click opens it).

One control covers both web addresses and pages: the form's single field takes either, lists
matching pages under it (`linkPages(workspace)`), and Apply/Enter on non-address words takes
the first match. A page destination is an ordinary link with href `#<pageId>`
(`pageIdOfLink`, `pageLinkUrl`); the card shows the page title with a go-to button
(`options.navigate`) or "Page removed". Cmd/Ctrl+K is Quick Find, so it is deliberately not a
link shortcut. The presentation editor reuses the form (see `presentation.md`).

## Tests

`document-model`, `document-commands`, `document-render`, `document-nesting`, `app-inline`,
`app-block-editor`, `app-block-fragment`, `app-block-clipboard`, `app-links`, `app-block-references`, `app-inline-references`.
