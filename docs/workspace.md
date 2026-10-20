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
supports per-transaction undo/redo, tracks dirty state, emits `change` events and exposes
`canUndo` / `canRedo` / `hasCommand` for the UI. `getFavorites()` returns favourite ids that
still exist.

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
export validates first and refuses to write a corrupt workspace. Persistence (IndexedDB autosave) is Phase 7; for now
the workspace is in memory with a dirty dot, and Cmd/Ctrl+S calls `markSaved`.

## Tests

`ids`, `events`, `schema`, `store`, `format`, `workspace-schema` additions.
