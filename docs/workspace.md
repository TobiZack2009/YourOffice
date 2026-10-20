# Workspace foundation

`src/core/` and `src/workspace/`. Done (Phase 1).

## Core

- `ids.js`: stable prefixed IDs (`page_`, `slide_`, `obj_`, `anim_`, ...).
- `events.js`: pub/sub.
- `errors.js`: `WorkspaceFormatError`, `CommandError(message, reason)`.

## Schema (`workspace/schema.js`)

- Versioned `YourOffice-workspace` format, migration registry and `migrateWorkspace()`.
- `validateWorkspace()` never throws; it returns an error list. It also checks section and
  reference integrity and cycles on import (Phase 6).
- `PAGE_TYPES` = document / sheet / presentation.
- `pageOrder` is `{ root: [...], [parentId]: [...] }`.
- `settings` is free-form; validation checks the shape of `favoritePageIds`.
- `detached` (Phase 6) is an additive field; no version bump. See `references.md`.

## Store (`workspace/store.js`)

`Workspace` runs command dispatch inside transactions, rolls back by snapshot on throw,
supports per-transaction undo/redo, tracks dirty state, emits `change` events and exposes
`canUndo` / `canRedo` / `hasCommand` for the UI. `getFavorites()` returns favourite ids that
still exist.

## Built-in commands (`workspace/commands.js`)

`createPage`, `renamePage`, `deletePage` (refuses to orphan children), `movePage` (cannot
move under its own descendant), `renameWorkspace`, `setPageContent` (deep-copied content),
`setFavorite` (undoable; `deletePage` prunes it). Page rename/move/delete hook into the
reference rewrite and detach logic (`references.md`).

## Import / export (`workspace/format.js`)

`exportWorkspaceJSON` / `importWorkspaceJSON`, round-trip tested. Malformed or invalid input
is rejected with `WorkspaceFormatError`. Persistence (IndexedDB autosave) is Phase 7; for now
the workspace is in memory with a dirty dot, and Cmd/Ctrl+S calls `markSaved`.

## Tests

`ids`, `events`, `schema`, `store`, `format`, `workspace-schema` additions.
