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

- Each run-capable block or list item is its own `contenteditable`. Structure changes (Enter
  split, Backspace merge/delete, list item split/exit, arrow navigation) dispatch commands and
  re-render; the browser never restructures the DOM.
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
- **Multi-block selection.** Selection across blocks is explicit state `sel = {anchor, focus}`
  over unit keys `blockId` / `blockId:itemId` in DOM order. Triggers: drag across units,
  shift-click, Shift+Arrow at a text edge, Escape (select current unit), Cmd/Ctrl+A (unit
  text, then all). With a selection: Backspace/Delete removes the units (one transaction,
  keeps an empty paragraph); ribbon type/mark controls apply to every unit; arrows move or
  extend; Escape/Enter return to editing. Styling `.is-block-selected`.
- **Trailing click.** Clicking below the last block focuses a trailing empty paragraph or
  appends one.
- **Right-click menu** (`openContextMenu`): Cut/Copy/Paste (best effort), marks (disabled
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
`app-block-editor`, `app-links`, `app-block-references`, `app-inline-references`.
