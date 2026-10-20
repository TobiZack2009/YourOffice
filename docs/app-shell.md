# App shell, ribbon and sidebar

`src/app/`: `shell.js`, `ribbon.js`, `ribbon-tabs.js`, `sidebar.js`, `popover.js`,
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

`mountApp(root, workspace, options)` builds sidebar, title strip, ribbon and canvas. It owns
page selection, recreates the editor per page, maps sidebar actions to workspace commands
(create seeds a starter paragraph) and holds the state that must survive a remount (current
slide per page via `lastSlideByPage`, presentation view toggles, clipboard, active slide
show). `options.onImport` lets `main.js` remount with an imported workspace. The returned
handle includes `getSlideshow` and `startSlideshow`.

- **File tab**: rename workspace, mark saved, export/import JSON.
- **View tab**: canvas zoom as a `--zoom` CSS variable, show/hide sidebar. Both are shell UI
  state, not model.
- **Global keys**: Cmd/Ctrl+K Quick Find, Cmd/Ctrl+S mark saved, undo/redo, Cmd/Ctrl+Enter slide
  show. All are ignored while a slide show is up. Undo/redo is the model's only on editing
  surfaces (`data-history="model"`: document editor, sheet grid, slide stage, slide strip, slide
  text editor) and when nothing editable has focus; text fields (page title, quick find, rename,
  link form, inspector, formula bar, in-cell input) and contenteditables outside a surface keep
  the browser's text undo (`history-scope.js`).

## Ribbon

- `ribbon-tabs.js` is pure data: `getTabs(pageType)` -> tabs -> groups -> controls
  (`button | toggle | select | menu | field | color`, each with `enabled(ctx)`, `active(ctx)`,
  `disabledReason`). Adding a tab or control is a data change.
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
