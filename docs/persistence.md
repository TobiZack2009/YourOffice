# Persistence and recovery

`src/persistence/` keeps the workspace between visits. It depends on `core`, `workspace` and
`domain` only; the shell receives autosave as an injected object (`options.persistence`) and
`main.js` wires the two together.

## Storage (`storage.js`)

An async adapter `{ load(id), save(record), list(), remove(id), durable }` over records
`{ id, savedAt, revision, data }`: `data` is the serialized workspace and `revision` counts the
writes of that workspace, so a second tab can see the stored copy moved on. Two implementations:

- `createIndexedDbStorage()`: database `yourOffice`, object store `workspaces` keyed by `id`,
  opened lazily.
- `createMemoryStorage()`: for tests and as the fallback.

`openStorage()` tries IndexedDB up front (a `list()` call) and falls back to memory, returning
the reason, when the API is missing or refuses (private mode, some `file://` contexts). The
fallback is not `durable`: `main.js` then skips autosave, tells the user nothing will be kept
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

## Start-up (`restore.js`, `main.js`)

`main.js` reads the id of the last workspace from a `localStorage` pointer
(`yourOffice.lastWorkspace`), loads that record and rebuilds it with `workspaceFromJSON` (the
full validation rules).

- Success: the workspace is mounted as already persisted, at the record's revision.
- Nothing stored: `app/demo-seed.js` builds the welcome workspace (document, budget sheet,
  deck) and it is written by autosave.
- A record that fails validation is never rewritten: it is copied to `<id>.recovery-<time>`,
  the user gets a notice saying so, and the welcome workspace opens (the pointer moves to it,
  so the original is not overwritten).
- File > Import mounts the imported workspace as unsaved; autosave then stores it under its id.

## Not done

- Multi-tab locking or merging (only the conflict notice).
- A UI to list, open or delete stored workspaces and recovery copies.
- Image/asset storage separate from page content.
