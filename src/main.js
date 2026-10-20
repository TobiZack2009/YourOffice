/**
 * Vite entry: open the last workspace from local storage (or the welcome workspace), keep it
 * saved as the user works, and mount the shell.
 */

import "./app/styles.css";
import { mountApp } from "./app/shell.js";
import { createSession } from "./app/session.js";
import { createDemoWorkspace } from "./app/demo-seed.js";
import { openStorage } from "./persistence/storage.js";
import { createAutosave, attachPageLifecycle } from "./persistence/autosave.js";
import { restoreWorkspace, storagePointer } from "./persistence/restore.js";

/** @typedef {import("./workspace/store.js").Workspace} Workspace */

const root = document.getElementById("app");
if (!root) throw new Error("missing #app element");

/** @returns {Pick<Storage, "getItem" | "setItem">} localStorage, or an inert stand-in when blocked. */
function localStore() {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

/** Zoom, sidebar and ribbon preferences survive a reload; ids in it are checked on use. */
function openSession() {
  try {
    return createSession({}, { storage: window.localStorage, key: "yourOffice.session" });
  } catch {
    return createSession();
  }
}

async function start() {
  const session = openSession();
  const pointer = storagePointer(localStore());
  const { storage, fallback } = await openStorage();
  const restored = await restoreWorkspace({ storage, pointer });

  /** @type {string[]} */
  const notices = [];
  if (!storage.durable) {
    notices.push(
      `This page cannot keep your work between visits (${fallback?.message ?? "no storage"}). Use File > Export to save it.`
    );
  }
  if (restored.failure) {
    notices.push(
      `Your saved workspace could not be opened (${restored.failure.error.message}). It was left as it is` +
        `${restored.failure.recoveryId ? ` and copied to "${restored.failure.recoveryId}"` : ""}; the welcome workspace is open instead.`
    );
  }

  /** @type {ReturnType<typeof mountApp> | null} */
  let app = null;
  /** @type {ReturnType<typeof createAutosave> | null} */
  let autosave = null;
  /** @type {(() => void) | null} */
  let detach = null;

  /**
   * @param {Workspace} workspace
   * @param {{ persisted: boolean, revision: number }} stored Whether the workspace is what storage holds.
   */
  function mount(workspace, stored) {
    detach?.();
    autosave?.destroy();
    app?.destroy();
    autosave = null;
    detach = null;

    if (storage.durable) {
      pointer.set(workspace.id);
      autosave = createAutosave(workspace, storage, {
        persisted: stored.persisted,
        revision: stored.revision,
        onConflict: () => app?.notify("This workspace was changed in another tab; saving here replaces that copy.")
      });
      detach = attachPageLifecycle(autosave);
    } else {
      const warn = (/** @type {BeforeUnloadEvent} */ event) => {
        if (!workspace.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      detach = () => window.removeEventListener("beforeunload", warn);
    }

    app = mountApp(/** @type {HTMLElement} */ (root), workspace, {
      session,
      persistence: autosave ?? undefined,
      onImport: (imported) =>
        void storage
          .load(imported.id)
          .catch(() => undefined)
          .then((record) => mount(imported, { persisted: false, revision: record?.revision ?? 0 }))
    });
    return app;
  }

  const opened = restored.workspace
    ? mount(restored.workspace, { persisted: true, revision: restored.revision })
    : mount(createDemoWorkspace(), { persisted: false, revision: 0 });
  if (notices.length > 0) opened.notify(notices.join(" "));
}

void start();
