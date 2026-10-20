# Workspace foundation

`src/core/` and `src/workspace/`. Done (Phase 1).

## Core

- `ids.js`: stable prefixed IDs (`page_`, `slide_`, `obj_`, `anim_`, ...).
- `events.js`: pub/sub. A listener unsubscribed during an emit is skipped; listener errors are
  isolated and go to `emitter.onError` (the shell shows a notice); `strict: true` rethrows.
- `url.js`: `isSafeUrl` (http/https/mailto/tel/ftp/sms, `#page` and relative addresses; never
  `javascript:`, `data:`, `vbscript:`, `file:`, also with control characters inside the scheme).
- `errors.js`: `WorkspaceFormatError`, `CommandError(message, reason)`.

## Schema (`workspace/schema.js`)

- Versioned `YourOffice-workspace` format, migration registry and `migrateWorkspace()`.
- `validateWorkspace(data, { contentValidators })` never throws; it returns an error list. It also
  checks section and reference integrity and cycles on import (Phase 6). With content validators
  it checks each page's content by type; a page with no `content` is a fresh page and stays valid.
- `PAGE_TYPES` = document / sheet / presentation.
- `pageOrder` is `{ root: [...], [parentId]: [...] }`.
- `settings` is free-form; validation checks the shape of `favoritePageIds`.
- `detached` (Phase 6) is an additive field; no version bump. See `references.md`.

## Store (`workspace/store.js`)

A bare `Workspace` registers only the workspace commands; features are installed by
`domain/installDomain`. `registerCommand(type, handler, { hot, selfManaged })` stores facts that
hooks read through `commandMeta(type)`. `configureValidation({ contentValidators,
integrityChecks })` sets the rules used by `setPageContent`, import and export (the domain
supplies the full set; a bare store checks the envelope only).

`Workspace` runs command dispatch inside transactions, rolls back by snapshot on throw,
supports per-transaction undo/redo, tracks dirty state through its history, emits `change` events and exposes
`canUndo` / `canRedo` / `hasCommand` for the UI. `getFavorites()` returns favourite ids that
still exist.

### History (`workspace/history.js`)

Whole-state snapshots, one per transaction. A commit clones the workspace once (the state
before the transaction); an entry keeps the state on its other side, and undo/redo swap it with
the live data, so stepping through history clones nothing.

- **Coalescing**: `dispatch(type, payload, { coalesce: key })`. A commit whose commands all carry
  the same key merges into the previous entry when that entry has the key, nothing has happened
  since (another commit, undo, redo or save) and it is within `history.coalesceWindow` (1000 ms).
  One undo then reverts the whole run. Each commit still emits its own `change` event. The
  document editor keys typing per block (or list item); a transaction whose commands disagree on
  the key does not merge.
- **Cap**: `history.maxEntries` (200); the oldest entries are dropped.
- **Revisions and dirty**: every commit or merge takes the next revision; the head revision is
  the last entry's, or `baseRev` when the stack is empty or trimmed. `markSaved()` stores
  `savedRev`, and `workspace.dirty` is a getter (`headRev !== savedRev`). Undoing back to the
  saved state is clean; a saved state trimmed out of reach stays dirty. `markSaved()` also stops
  later commits from merging into earlier ones.

### Results, change sets and selectors

- `dispatch(type, payload, { origin })` returns the handler's result. Creating commands return
  ids: `createPage {pageId}`, `createTable {tableId}`, `createSlide`/`duplicateSlide {slideId}`,
  `insertObject {objectId}`, `duplicateObjects`/`pasteObjects {objectIds}`, `addAnimation
  {animationId}`, `insertBlock {blockId}`, `addListItem {itemId}`, `createSection {sectionId}`,
  `insertReference {instanceId}`. `transact` returns its callback's result.
- A transaction collects what it touched: `tx.touch(pageId, ...entityIds)`. No entity ids means
  the whole page (`WHOLE_PAGE`), and a whole-page touch wins over precise ones. Entity ids are
  block ids (document), table ids (sheet), slide and object ids (presentation; a slide id alone
  means the slide as a whole).
- The `change` event is `{ kind: commit|undo|redo, transactionId, label, commands, pages,
  entities, registry, origin }`. `registry` is true when the page list, titles, hierarchy,
  favourites or workspace title changed (commands registered with `registry: true`); undo and redo
  carry the entry's pages and entities with `registry: true`. `origin` is taken from the first
  command that names one, so an editor can recognise its own commits. Helpers are in
  `workspace/changes.js` (`touchesPage`, `entitiesOf`).
- `workspace/selectors.js` answers render-path questions without cloning: `pageExists`,
  `pageTitle`, `pageType`, `pageInfo`, `pageContent` (live, read-only), `pageList`, `breadcrumb`,
  `pageTree`. `getPage`/`getPages` remain as explicit snapshot APIs.

## Built-in commands (`workspace/commands.js`)

`createPage`, `renamePage`, `deletePage` (refuses to orphan children), `movePage` (cannot
move under its own descendant), `renameWorkspace`, `setPageContent` (deep-copied content, validated for the page's type),
`setFavorite` (undoable; `deletePage` prunes it). Page create/rename/move/delete are
plain model edits; the reference rewrite and detach logic run from the reference hook
(`references.md`).

## Import / export (`workspace/format.js`)

`exportWorkspaceJSON` / `importWorkspaceJSON(text, { validation, install })`, round-trip tested;
`domain/` exports the fully configured pair. Malformed or invalid input
(including malformed page content or an unsafe link) is rejected with `WorkspaceFormatError`;
export validates first and refuses to write a corrupt workspace. Autosave to IndexedDB is in `persistence/` (see
`persistence.md`); `workspace.revision` is the head revision it tracks. Without persistence
the dirty dot follows `workspace.dirty` and Cmd/Ctrl+S calls `markSaved`.

## Tests

`ids`, `events`, `schema`, `store`, `format`, `workspace-schema` additions,
`workspace-selectors`, `workspace-changes`, `workspace-history`.
