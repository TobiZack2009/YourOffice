# App shell, ribbon and sidebar

`src/app/`: `shell.js`, `session.js`, `selection.js`, `keyboard.js`, `gesture.js`, `notice.js`,
`history-scope.js`, `demo-seed.js`, `ribbon.js`, `ribbon-tabs.js`, `sidebar.js`, `popover.js`,
`icons.js`, `quick-find.js`, `dom.js`, `styles.css`.

## Layout

Full-height Notion-style sidebar; the main column is title strip (breadcrumb, undo/redo,
play button, dirty dot) -> ribbon (tab strip + panel of labelled groups) -> canvas (page
header, editor).

```
+-----------+--------------------------------------------------------+
| sidebar   | title strip: workspace > page, undo/redo, dirty dot    |
|           | ribbon:      File | Home | Insert | ... | View         |
|           |              labelled groups of large/small buttons    |
|           +--------------------------------------------------------+
|           | canvas (page header, editor)                           |
+-----------+--------------------------------------------------------+
```

The page editor is the whole canvas (no max-width card): `.app` fills `#app`, and
`.page-body` / `.sheet-editor` flex to fill it. `data-page-type` on `.app` drives the accent
(document blue, sheet green, presentation orange). `styles.css` is built on CSS variables.

## Shell (`shell.js`)

`mountApp(root, workspace, options)` installs the domain on the workspace (idempotent) and builds sidebar, title strip, ribbon and canvas. It owns
page selection, builds one editor per page, maps sidebar actions to workspace commands
(create seeds a starter paragraph). What must survive a remount lives in the session (below),
not in shell globals; only the active slide show is shell state. `options.onImport` lets
`boot.js` remount with an imported workspace, and `options.session` supplies the session
(`main.js` passes a `localStorage`-backed one). The returned handle includes `getSlideshow` and
`startSlideshow`.

Editors follow changes themselves (`applyChange`-style: each one re-renders only when the
change touches its page, or a page it draws through embeds and expressions, and carries the
selection across undo/redo). The shell remounts only on a page switch, when the open page is
gone, or when its type changed; renaming the open page updates the title input and breadcrumb
in place. Chrome is split: the undo/redo buttons, dirty dot and play button update on every
change; the breadcrumb only on registry changes; the ribbon at most once per animation frame
(a test that reads ribbon state after an editor event awaits a frame).

Rendering is keyed everywhere a change used to rebuild a pane, so untouched nodes stay the same
element and a focused one keeps its caret. The shared primitive is `core/reconcile.js`
`reconcileChildren(parent, nodes)`: it removes what is no longer wanted and inserts only what is
out of place. The sidebar caches a row per page id (rebuilt when its title, type, children,
collapsed or editing state changes; selection and depth are patched), the ribbon builds its
controls once per page type and tab and then only `update()`s state, and the slide strip caches a
thumbnail per slide id (patching number, `data-index`, current/selected). A thumbnail that draws
references is redrawn on every pass because it reads other pages. The inspector already syncs
values into existing inputs, and the animation timeline keeps its own focus handling.

`options.persistence` (an autosave handle, injected by `boot.js`) changes what the dirty dot
means (changes not yet stored), makes Cmd+S flush with a "Saved" notice, and surfaces a failed
write once. The returned handle has `notify(message)` for start-up messages.

`notice.js` is `createNotice(getContainer)` -> `{ show, clear, guard }`; the shell creates one
per mount and hands it to its editors (`options.notice`), so two mounted apps do not share
messages. A module-level `defaultNotice` serves code mounted without one. Popover hosts are
already one per editor and ribbon.

`gesture.js` is `createGestureScope(doc)`: the document-level `mousemove`/`mouseup` listeners
of a drag (block drag, sheet fill/move/resize, slide move/resize/rotate/path) register through
a scope that an editor aborts on `destroy`, so destroying an editor mid-gesture leaves no
listeners and commits nothing.

### Session (`session.js`, `selection.js`)

The session is what the user is doing, as opposed to what is true: `selectedPageId`, `zoom`,
`sidebarVisible`, `sidebarCollapsed`, `ribbonTabByType`, `presentationView` (inspector, snap,
grid, timeline), `presentationClipboard`, `slideByPage` and `selections` (one logical selection
per page). `createSession(initial, { storage, key })` returns `{ get, set, subscribe, toJSON,
restore }`: `get` is read-only, `set(patch)` is the single writer and returns the keys that
changed (structural equality, so rewriting a value is not a change), and `restore` ignores
anything malformed. With `storage` it loads on creation and saves on every change; the clipboard
is volatile and never saved. The session is not part of the workspace: none of it is undoable or
exported. Shell, ribbon, sidebar and the presentation editor read and write through it (the
editor takes the view and clipboard as initial values and reports changes through
`onViewChange` / `onClipboardChange`).

`selection.js` defines the logical selections, all plain JSON: document `{ type: "text", anchor,
focus }` (points are `{ blockId, itemId?, offset }`) or `{ type: "units", anchor, focus }` (whole
blocks/items by unit key), sheet `{ tableId, anchor, focus, others }`, presentation `{ slideId,
objectIds }`. `read*` checks the shape of a stored value and `clamp*` drops what no longer
exists. Each editor handle has `captureSelection()` and `restoreSelection(value)` (document: a
DOM range <-> logical points; sheet and presentation already hold logical state), `dependsOn()`
(the pages it draws) and `focus()`. Before a remount the shell captures the open editor's
selection into `selections[pageId]` and puts it back into the new editor; the document
selection is restored only for the same page, and a presentation selection only when it was
taken on the slide being reopened, so a redo that brings a slide back reopens that slide.

- **File tab**: rename workspace, mark saved, export/import JSON.
- **View tab**: canvas zoom as a `--zoom` CSS variable, show/hide sidebar. Both are shell UI
  state, not model.
- **Global keys** (`keyboard.js`): one document `keydown` listener (`createKeyboard`) looks a
  chord up in a table of shortcuts `{ keys, scope, when, run }`; `keys` is written
  `mod+shift+z|mod+y` (`mod` is Cmd or Ctrl). A scope stack decides which rows apply: `global` is
  always at the bottom, and a modal scope pushed above it hides everything beneath. The shell
  defines Cmd/Ctrl+K Quick Find, Cmd/Ctrl+S mark saved, undo/redo and Cmd/Ctrl+Enter (Shift:
  from the current slide) slide show, and pushes a modal `slideshow` scope while a show is up,
  so none of them fire then. Undo/redo is the model's only on editing surfaces
  (`data-history="model"`: document editor, sheet grid, slide stage, slide strip, slide text
  editor) and when nothing editable has focus; text fields (page title, quick find, rename, link
  form, inspector, formula bar, in-cell input) and contenteditables outside a surface keep the
  browser's text undo (`history-scope.js`, used as the shortcuts' `when`). Editors keep their
  own element-level handlers for typing and navigation.

## Ribbon

- `ribbon-tabs.js` is pure data: `getTabs(pageType)` -> tabs -> groups -> controls
  (`button | toggle | select | menu | field | color`, each with `enabled(ctx)`, `active(ctx)`,
  `disabledReason`). Adding a tab or control is a data change. `getTabs` assembles File, the
  page type's own tabs and View; the own tabs live in `ribbon-tabs-document.js`,
  `ribbon-tabs-sheet.js` and `ribbon-tabs-presentation.js` (with `ribbon-animation.js`), over
  `ribbon-shared.js` (context and control types, enable predicates, popover bodies, factories).
- `ctx` is `{ workspace, page, docEditor, sheetEditor, presentationEditor, shell }`; `shell`
  is the narrow `ShellApi` (undo/redo/save/export/import/zoom/sidebar, `startSlideshow`,
  `isSlideshowActive`).
- `ribbon.js` renders the data and keeps `enabled`/`active` fresh via `update()`, which the
  shell calls wherever editor or workspace state changes (including `onSelectionChange`,
  which also fires when the clipboard changes). Buttons cancel `mousedown` so the editor
  selection survives. `createRibbon(..., { onTabChange })` reports the active tab.
- Tabs per page type: document (Home, Insert), sheet (Home, Insert, Layout), presentation
  (Home, Insert, Design, Transitions, Animations, Slide Show, View). File and View appear on
  everything.
- Document Home has a Style `select` (Paragraph / Heading 1-3, `data-action="block-style"`),
  Quote / Code / List toggles, and Indent / Outdent (disabled when they would do nothing). The
  Insert tab's Heading is a menu of levels, and a single Link control covers web addresses and
  pages.

## Sidebar (`sidebar.js`)

Page tree with selection, inline rename (double-click), delete, expand carets (local state),
a Favorites section, and a search field that opens Quick Find. The header "+" opens a type
picker (`.new-page[data-type]`); row hover "+" creates a child; the row "..." menu has Rename /
Favorite / Delete. The whole `.page-row` / `.favorite-row` selects its page (`selectFromRow`);
clicks on the caret, `.page-actions` and the rename input are ignored. Drag-to-nest uses the
pure `planDrop(workspace, dragId, target)` (`{type: "onto" | "before" | "after" | "root"}` ->
`{newParentId, index}`), which includes cycle prevention.

## Popovers and menus (`popover.js`)

`createPopoverHost` with `showAt(point, content, {class})` (viewport-clamped, closes on Escape
or outside press) and `buildMenu`. `MenuItem.submenu` -> `buildSubmenu`: a trigger showing the
section name and a chevron, flyout on hover/click (flips left near the window edge). Context
menus mount on `document.body` so view zoom does not skew `position: fixed`. Items keep
`data-action`s.

## Icons (`icons.js`)

Each icon name maps to a Lucide icon node (named imports from `lucide`, so unused icons are
tree-shaken). The `icon()` / `hasIcon()` API and the `icon icon-<name>` / `data-icon`
attributes are the contract. Hand-drawn nodes remain only for icons Lucide lacks (table-new,
row/column delete, shift-*, fill-all, rect, bring-forward, send-backward).

## Quick Find (`quick-find.js`)

Cmd/Ctrl+K overlay; `findPages` is the pure filter.

## DOM helpers (`dom.js`)

`h` / `clear` / `fragment` build elements (attributes, `on*` handlers, dataset; text via
`textContent` only).

## Tests

`app-shell`, `app-ribbon`, `app-sidebar`, `app-popover`, `app-quick-find`.
