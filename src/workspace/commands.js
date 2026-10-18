/**
 * Workspace-level commands (spec §11: validated, typed commands).
 *
 * Every mutation of workspace-level state goes through `dispatch`. Handlers are
 * pure mutators over the store's `_data` and must not touch the DOM; they may
 * throw CommandError before or after mutating — transactions roll back either way.
 *
 * Payload validation is intentionally explicit and boring: unknown command type,
 * wrong field types, missing pages, and hierarchy rules all throw with a
 * machine-readable `reason`.
 */

import { createId } from "../core/ids.js";
import { CommandError } from "../core/errors.js";
import { PAGE_TYPES } from "./schema.js";
import { retargetReferences, snapshotReferences } from "../references/rewrite.js";

/** @typedef {import("./store.js").Workspace} Workspace */
/** @typedef {import("./store.js").Transaction} Transaction */
/** @typedef {import("./schema.js").PageType} PageType */

/**
 * @param {Workspace} store
 * @param {unknown} value
 * @param {string} field
 * @param {string} reason
 * @param {new (...args: unknown[]) => Error} ErrorType
 */
function isNonEmptyString(value, field, reason, ErrorType) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ErrorType(`${field} must be a non-empty string`, reason);
  }
}

/**
 * Bump a page's modifiedAt and record it in the transaction. Shared with other
 * command modules (e.g. document blocks).
 * @param {Transaction} tx
 * @param {import("./schema.js").PageEnvelope} page
 */
export function touchPage(tx, page) {
  page.modifiedAt = new Date().toISOString();
  tx.pageIds.add(page.id);
}

/**
 * Touch whatever holds content under `id`: a page or a detached entry. Unknown ids are ignored.
 * @param {Workspace} store
 * @param {Transaction} tx
 * @param {string} id
 */
export function touchContainer(store, tx, id) {
  const container = store._data.pages[id] ?? store._data.detached?.[id];
  if (container) touchPage(tx, container);
}

/**
 * Whether `maybeDescendantId` is `pageId` itself or one of its descendants.
 * @param {Workspace} store
 * @param {string} pageId
 * @param {string} maybeDescendantId
 * @returns {boolean}
 */
function isSelfOrDescendant(store, pageId, maybeDescendantId) {
  let cursor = maybeDescendantId;
  let guard = 0;
  while (cursor !== "" && guard++ <= Object.keys(store._data.pages).length) {
    if (cursor === pageId) return true;
    cursor = store.getParent(cursor) ?? "";
  }
  return false;
}

/** Commands are registered by calling this once at store setup. */
export const commands = {
  /**
   * Create a page, appending or inserting it into the hierarchy.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ type: PageType, title?: string, parentId?: string | null, index?: number, content?: Record<string, unknown> }} payload
   * @example store.dispatch("createPage", { type: "document", title: "Notes" })
   * @example store.dispatch("createPage", { type: "sheet", parentId: somePageId, index: 0 })
   */
  createPage(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    isNonEmptyString(p.type, "type", "invalidType", CommandError);
    if (!PAGE_TYPES.includes(/** @type {PageType} */ (p.type))) {
      throw new CommandError(
        `unknown page type: ${p.type} (expected one of ${PAGE_TYPES.join(", ")})`,
        "invalidType"
      );
    }

    /** @type {string | null} */
    let parentId = null;
    if (p.parentId !== undefined && p.parentId !== null) {
      isNonEmptyString(p.parentId, "parentId", "invalidParent", CommandError);
      if (!store._data.pages[p.parentId]) {
        throw new CommandError(`parent page does not exist: ${p.parentId}`, "unknownPage");
      }
      parentId = p.parentId;
    }

    const timestamp = new Date().toISOString();
    const page = {
      id: createId(/** @type {string} */ (p.type) === "presentation" ? "pres" : p.type),
      type: /** @type {PageType} */ (p.type),
      title: typeof p.title === "string" ? p.title : "",
      createdAt: timestamp,
      modifiedAt: timestamp,
      ...(p.content !== undefined ? { content: p.content } : {})
    };

    const siblings =
      parentId === null ? store._data.pageOrder.root : (store._data.pageOrder[parentId] ?? []);

    if (p.index !== undefined) {
      if (typeof p.index !== "number" || !Number.isInteger(p.index)) {
        throw new CommandError("index must be an integer", "invalidIndex");
      }
      if (p.index < 0 || p.index > siblings.length) {
        throw new CommandError(
          `index ${p.index} out of range (children: ${siblings.length})`,
          "invalidIndex"
        );
      }
    }
    const index = p.index === undefined ? siblings.length : p.index;

    // A new page can start shadowing a name that formulas already use.
    const snapshot = snapshotReferences(store._data);
    store._data.pages[page.id] = page;
    siblings.splice(index, 0, page.id);
    if (parentId !== null) {
      store._data.pageOrder[parentId] = /** @type {string[]} */ (siblings);
    }
    tx.pageIds.add(page.id);
    retargetReferences(store._data, snapshot, (id) => touchContainer(store, tx, id));
  },

  /**
   * Rename a page.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, title: string }} payload
   */
  renamePage(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    isNonEmptyString(p.pageId, "pageId", "invalidPage", CommandError);
    if (typeof p.title !== "string") {
      throw new CommandError("title must be a string", "invalidTitle");
    }
    const page = store._data.pages[p.pageId];
    if (!page) {
      throw new CommandError(`page does not exist: ${p.pageId}`, "unknownPage");
    }
    if (page.title === p.title) return;
    const snapshot = snapshotReferences(store._data);
    page.title = p.title;
    touchPage(tx, page);
    retargetReferences(store._data, snapshot, (id) => touchContainer(store, tx, id));
  },

  /**
   * Delete a page. Deleting a page with children requires cascade: true, which
   * deletes the whole subtree and leaves no orphans behind.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, cascade?: boolean }} payload
   */
  deletePage(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    isNonEmptyString(p.pageId, "pageId", "invalidPage", CommandError);
    const page = store._data.pages[p.pageId];
    if (!page) {
      throw new CommandError(`page does not exist: ${p.pageId}`, "unknownPage");
    }

    const childIds = store.getChildren(p.pageId);
    if (childIds.length > 0 && p.cascade !== true) {
      throw new CommandError(
        `page ${p.pageId} has ${childIds.length} child page(s); pass cascade: true to delete them`,
        "wouldOrphan"
      );
    }

    // Collect the whole subtree, deepest pages of each branch are irrelevant:
    // deleting every listed id removes them regardless of order.
    /** @type {string[]} */
    const doomed = [p.pageId];
    /** @type {string[]} */
    const queue = [...childIds];
    while (queue.length > 0) {
      const current = /** @type {string} */ (queue.shift());
      doomed.push(current);
      queue.push(...store.getChildren(current));
    }

    for (const id of doomed) {
      delete store._data.pages[id];
      delete store._data.pageOrder[id];
      tx.pageIds.add(id);
    }

    const favorites = store._data.settings?.favoritePageIds;
    if (Array.isArray(favorites)) {
      store._data.settings.favoritePageIds = favorites.filter((id) => !doomed.includes(id));
    }

    const parentLists = [store._data.pageOrder.root, ...Object.values(store._data.pageOrder)];
    for (const list of parentLists) {
      if (Array.isArray(list)) {
        for (const id of doomed) {
          const at = list.indexOf(id);
          if (at !== -1) list.splice(at, 1);
        }
      }
    }
  },

  /**
   * Move a page within or across parents, with cycle prevention.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, newParentId?: string | null, index?: number }} payload
   */
  movePage(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    isNonEmptyString(p.pageId, "pageId", "invalidPage", CommandError);
    const page = store._data.pages[p.pageId];
    if (!page) {
      throw new CommandError(`page does not exist: ${p.pageId}`, "unknownPage");
    }

    /** @type {string | null} */
    let newParentId = null;
    if (p.newParentId !== undefined && p.newParentId !== null) {
      isNonEmptyString(p.newParentId, "newParentId", "invalidParent", CommandError);
      if (!store._data.pages[p.newParentId]) {
        throw new CommandError(`parent page does not exist: ${p.newParentId}`, "unknownPage");
      }
      if (isSelfOrDescendant(store, p.pageId, p.newParentId)) {
        throw new CommandError(
          `cannot move page ${p.pageId} under itself or one of its descendants`,
          "cycle"
        );
      }
      newParentId = p.newParentId;
    }

    const target =
      newParentId === null ? store._data.pageOrder.root : (store._data.pageOrder[newParentId] ?? []);

    if (p.index !== undefined) {
      if (typeof p.index !== "number" || !Number.isInteger(p.index)) {
        throw new CommandError("index must be an integer", "invalidIndex");
      }
      if (p.index < 0 || p.index > target.length) {
        throw new CommandError(
          `index ${p.index} out of range (children: ${target.length})`,
          "invalidIndex"
        );
      }
    }

    // A move changes which names are visible from where, so formulas are respelled afterwards.
    const snapshot = snapshotReferences(store._data);

    // Remove from current position first, so index math is stable.
    const currentParent = store.getParent(p.pageId);
    const currentSiblings =
      currentParent === null ? store._data.pageOrder.root : (store._data.pageOrder[currentParent] ?? []);
    const at = currentSiblings.indexOf(p.pageId);
    if (at !== -1) currentSiblings.splice(at, 1);

    const index = p.index === undefined ? target.length : p.index;
    target.splice(/** @type {number} */ (index), 0, p.pageId);

    if (newParentId !== null) {
      store._data.pageOrder[newParentId] = /** @type {string[]} */ (target);
    }
    touchPage(tx, page);
    retargetReferences(store._data, snapshot, (id) => touchContainer(store, tx, id));
  },

  /**
   * Rename the workspace (metadata.title).
   * @param {Workspace} store
   * @param {Transaction} _tx
   * @param {{ title: string }} payload
   */
  renameWorkspace(store, _tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    if (typeof p.title !== "string") {
      throw new CommandError("title must be a string", "invalidTitle");
    }
    store._data.metadata.title = p.title;
  },

  /**
   * Add or remove a page from the favorites list (settings.favoritePageIds).
   * @param {Workspace} store
   * @param {Transaction} _tx
   * @param {{ pageId: string, favorite: boolean }} payload
   */
  setFavorite(store, _tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    isNonEmptyString(p.pageId, "pageId", "invalidPage", CommandError);
    if (typeof p.favorite !== "boolean") {
      throw new CommandError("favorite must be a boolean", "invalidFavorite");
    }
    if (!store._data.pages[p.pageId]) {
      throw new CommandError(`page does not exist: ${p.pageId}`, "unknownPage");
    }
    const current = Array.isArray(store._data.settings.favoritePageIds)
      ? store._data.settings.favoritePageIds
      : [];
    const without = current.filter((id) => id !== p.pageId);
    store._data.settings.favoritePageIds = p.favorite ? [...without, p.pageId] : without;
  },

  /**
   * Update a page's content object for its type. Type-specific editors later
   * get finer-grained commands; this is the generic seed.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, content: Record<string, unknown> }} payload
   */
  setPageContent(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    isNonEmptyString(p.pageId, "pageId", "invalidPage", CommandError);
    if (typeof p.content !== "object" || p.content === null || Array.isArray(p.content)) {
      throw new CommandError("content must be a plain object", "invalidContent");
    }
    const page = store._data.pages[p.pageId];
    if (!page) {
      throw new CommandError(`page does not exist: ${p.pageId}`, "unknownPage");
    }
    page.content = structuredClone(p.content);
    touchPage(tx, page);
  }
};

/** @param {Workspace} store */
export function registerWorkspaceCommands(store) {
  for (const [type, handler] of Object.entries(commands)) {
    store.registerCommand(type, handler);
  }
}
