/**
 * Boot: open the last workspace from storage (or the welcome workspace), keep it saved as the
 * user works, and mount the shell. Everything environmental (the root element, storage, the
 * pointer store, the session) is passed in, so a test can boot the whole app in jsdom.
 */

import { mountApp } from "./app/shell.js";
import { createSession } from "./app/session.js";
import { createBlankWorkspace, createDemoWorkspace } from "./app/demo-seed.js";
import { openStorage as defaultOpenStorage } from "./persistence/storage.js";
import { createAutosave, attachPageLifecycle } from "./persistence/autosave.js";
import { restoreWorkspace, storagePointer } from "./persistence/restore.js";
import { listWorkspaces, loadWorkspace } from "./persistence/workspaces.js";

/** @typedef {import("./workspace/store.js").Workspace} Workspace */

/**
 * @typedef {object} BootOptions
 * @property {HTMLElement} root
 * @property {import("./app/session.js").Session} [session]
 * @property {Pick<Storage, "getItem" | "setItem">} [pointerStore] Holds the id of the last workspace.
 * @property {typeof defaultOpenStorage} [openStorage]
 *
 * @typedef {object} Booted
 * @property {() => ReturnType<typeof mountApp> | null} app
 * @property {() => Workspace | null} workspace
 * @property {() => ReturnType<typeof createAutosave> | null} autosave
 * @property {() => void} destroy
 */

/**
 * @param {BootOptions} options
 * @returns {Promise<Booted>}
 */
export async function boot(options) {
  const { root } = options;
  const session = options.session ?? createSession();
  const pointer = storagePointer(options.pointerStore ?? { getItem: () => null, setItem: () => undefined });
  const { storage, fallback } = await (options.openStorage ?? defaultOpenStorage)();
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

    current = workspace;
    app = mountApp(root, workspace, {
      session,
      persistence: autosave ?? undefined,
      workspaces: storage.durable ? manager : undefined,
      onImport: (imported) =>
        void storage
          .load(imported.id)
          .catch(() => undefined)
          .then((record) => mount(imported, { persisted: false, revision: record?.revision ?? 0 }))
    });
    return app;
  }

  /** @type {Workspace | null} */
  let current = null;

  /**
   * Leave the open workspace for another: what is open is stored first, and a failure to do so
   * keeps the user where they are.
   * @param {() => Promise<{ workspace: Workspace, persisted: boolean, revision: number }>} next
   */
  async function switchTo(next) {
    if (autosave && !(await autosave.flush())) {
      throw new Error(`The open workspace could not be saved first (${autosave.error?.message ?? "storage unavailable"}).`);
    }
    const target = await next();
    mount(target.workspace, target);
    if (!target.persisted) void autosave?.flush();
  }

  /** What the shell may do with stored workspaces; absent when nothing is kept between visits. */
  const manager = {
    list: async () => {
      await autosave?.flush(); // a workspace not yet written would otherwise be missing from its own list
      return listWorkspaces(storage, current?.id ?? null);
    },
    /** @param {string} title */
    create: (title) =>
      switchTo(async () => ({ workspace: createBlankWorkspace(title || "New workspace"), persisted: false, revision: 0 })),
    /** @param {string} id */
    open: (id) =>
      switchTo(async () => {
        const { workspace, revision } = await loadWorkspace(storage, id);
        return { workspace, persisted: true, revision };
      }),
    /** @param {string} id */
    async remove(id) {
      if (id === current?.id) throw new Error("The open workspace cannot be deleted; open another one first.");
      await storage.remove(id);
    }
  };

  const opened = restored.workspace
    ? mount(restored.workspace, { persisted: true, revision: restored.revision })
    : mount(createDemoWorkspace(), { persisted: false, revision: 0 });
  if (notices.length > 0) opened.notify(notices.join(" "));

  return {
    app: () => app,
    workspace: () => current,
    autosave: () => autosave,
    destroy() {
      detach?.();
      autosave?.destroy();
      app?.destroy();
      app = null;
      autosave = null;
      detach = null;
    }
  };
}
