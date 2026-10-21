# Persistence and recovery

`src/persistence/` keeps the workspace between visits. It depends on `core`, `workspace` and
`domain` only; the shell receives autosave as an injected object (`options.persistence`) and
`boot.js` wires the two together.

## Storage (`storage.js`)

An async adapter `{ load(id), save(record), list(), remove(id), durable }` over records
`{ id, savedAt, revision, data }`: `data` is the serialized workspace and `revision` counts the
writes of that workspace, so a second tab can see the stored copy moved on. Two implementations:

- `createIndexedDbStorage()`: database `yourOffice`, object store `workspaces` keyed by `id`,
  opened lazily.
- `createMemoryStorage()`: for tests and as the fallback.

`openStorage()` tries IndexedDB up front (a `list()` call) and falls back to memory, returning
the reason, when the API is missing or refuses (private mode, some `file://` contexts). The
fallback is not `durable`: `boot.js` then skips autosave, tells the user nothing will be kept
between visits, keeps the old "dirty until exported" behaviour and warns on unload while dirty.

## Autosave (`autosave.js`)

`createAutosave(workspace, storage, { persisted, revision, onConflict })` listens to `change`
and writes `workspace.serialized` after 1 s without changes, or after 10 s of continuous
changes at the latest. It tracks what it stored by `workspace.revision` (`persistedRev`), which
is separate from the explicit-export `savedRev` in the history: undoing back to the stored
revision is clean, and a failed write stays pending and is retried (on the next change, on
`flush`, or after the ten-second ceiling).

- `pending` / `status` (`saved | pending | saving | failed`) / `error` / `subscribe` /
  `flush()` (true when the stored copy is current) / `destroy()`.
- Before each write it reads the stored record; a `revision` newer than the one this tab last
  saw means another tab wrote, so `onConflict` fires (the shell shows a notice) and the write
  still happens: last write wins, the user is told. Locking is not implemented.
- `attachPageLifecycle(autosave)` flushes on `visibilitychange` (hidden) and `pagehide`, and
  asks the browser to confirm leaving (`beforeunload`) only while a write is pending or failed.
  An IndexedDB write begun while the page is going away is best effort.

In the shell the dirty dot means "changes not yet stored" when persistence is given, Cmd+S
flushes and shows "Saved" (or the failure), and a failing store raises a notice once. File >
Export is unchanged: it downloads JSON and calls `markSaved()`.

## Start-up (`restore.js`, `boot.js`)

`boot.js` reads the id of the last workspace from a `localStorage` pointer
(`yourOffice.lastWorkspace`), loads that record and rebuilds it with `workspaceFromJSON` (the
full validation rules). `boot(options)` takes the root, session, pointer store and storage opener as
parameters so `tests/boot.test.js` can run the whole start-up in jsdom; `main.js` only supplies the
real `#app`, `localStorage` and IndexedDB.

- Success: the workspace is mounted as already persisted, at the record's revision.
- Nothing stored: `app/demo-seed.js` builds the welcome workspace (document, budget sheet,
  deck) and it is written by autosave.
- A record that fails validation is never rewritten: it is copied to `<id>.recovery-<time>`,
  the user gets a notice saying so, and the welcome workspace opens (the pointer moves to it,
  so the original is not overwritten).
- File > Import mounts the imported workspace as unsaved; autosave then stores it under its id.

## Several workspaces (`workspaces.js`, File > Workspaces)

`listWorkspaces(storage, activeId)` turns the stored records into `{ id, title, savedAt, active,
recovery }` (real workspaces first, newest on top; recovery copies last) and `loadWorkspace(storage,
id)` rebuilds one through the full validation rules. `boot.js` wraps them, with create and remove,
in a manager that it hands to the shell as `options.workspaces`; the shell offers it as
`shell.listWorkspaces / openWorkspace / createWorkspace / deleteWorkspace` and the File tab shows
the popover built by `app/workspace-switcher.js`. The manager exists only when storage is durable.

- Listing first flushes autosave, so the open workspace is always in its own list.
- Opening or creating flushes the open workspace first; if that fails the user stays where they
  are and sees a notice. The new workspace is then mounted (new autosave, pointer moved).
- A new workspace is one empty document page, written straight away.
- Delete asks first; the open workspace cannot be deleted. Recovery copies can be deleted but not
  opened.

## Not done

- Multi-tab locking or merging (only the conflict notice).
- Image bytes are embedded in the stored workspace record (as base64); a separate blob store would
  avoid rewriting them on every save.
