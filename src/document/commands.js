/**
 * Document block commands (spec §5.2, §11).
 *
 * These mutate a document page's `content` (blocks + order) through the same
 * command/transaction machinery as workspace commands. They validate before
 * assigning, keep stable block ids, and touch the page's modifiedAt.
 *
 * Registered against a store with `registerDocumentCommands(store)` so the
 * workspace module never depends on the document editor.
 */

import { CommandError } from "../core/errors.js";
import { createId } from "../core/ids.js";
import { touchPage } from "../workspace/commands.js";
import {
  createBlock,
  ensureDocumentContent,
  validateBlock,
  validateRuns
} from "./model.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/store.js").Transaction} Transaction */
/** @typedef {import("./model.js").Block} Block */
/** @typedef {import("./model.js").InlineRun} InlineRun */

const RUN_BLOCK_TYPES = new Set(["paragraph", "heading", "quote"]);

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} reason
 * @returns {string}
 */
function requireString(value, field, reason) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError(`${field} must be a non-empty string`, reason);
  }
  return value;
}

/**
 * Resolve a document page or throw.
 * @param {Workspace} store
 * @param {unknown} pageId
 * @returns {{ page: import("../workspace/schema.js").PageEnvelope, content: import("./model.js").DocumentContent }}
 */
function requireDocumentPage(store, pageId) {
  const id = requireString(pageId, "pageId", "invalidPage");
  const page = store._data.pages[id];
  if (!page) throw new CommandError(`page does not exist: ${id}`, "unknownPage");
  if (page.type !== "document") {
    throw new CommandError(`page ${id} is not a document page`, "wrongPageType");
  }
  return { page, content: ensureDocumentContent(page) };
}

/**
 * Resolve a block inside a content object or throw.
 * @param {import("./model.js").DocumentContent} content
 * @param {unknown} blockId
 * @returns {Block}
 */
function requireBlock(content, blockId) {
  const id = requireString(blockId, "blockId", "invalidBlock");
  const block = content.blocks[id];
  if (!block) throw new CommandError(`block does not exist: ${id}`, "unknownBlock");
  return block;
}

/**
 * @param {import("./model.js").DocumentContent} content
 * @param {string} blockId
 * @returns {number} Index in blockOrder, or -1.
 */
function orderIndex(content, blockId) {
  return content.blockOrder.indexOf(blockId);
}

/** Document commands keyed by command type. */
export const documentCommands = {
  /**
   * Insert a block, optionally positioned.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, block: Record<string, unknown>, index?: number, afterBlockId?: string, beforeBlockId?: string }} payload
   * @example store.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "Hi" }] } })
   */
  insertBlock(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    if (typeof p.block !== "object" || p.block === null || Array.isArray(p.block)) {
      throw new CommandError("block must be an object", "invalidBlock");
    }
    const spec = /** @type {Record<string, unknown>} */ ({ ...p.block });
    const type = requireString(spec.type, "block.type", "invalidBlock");
    delete spec.id;
    const block = createBlock(type, spec);

    let index = content.blockOrder.length;
    if (p.afterBlockId !== undefined) {
      const at = orderIndex(content, requireString(p.afterBlockId, "afterBlockId", "invalidBlock"));
      if (at === -1) throw new CommandError("afterBlockId is not in this page", "unknownBlock");
      index = at + 1;
    } else if (p.beforeBlockId !== undefined) {
      const at = orderIndex(
        content,
        requireString(p.beforeBlockId, "beforeBlockId", "invalidBlock")
      );
      if (at === -1) throw new CommandError("beforeBlockId is not in this page", "unknownBlock");
      index = at;
    } else if (p.index !== undefined) {
      if (!Number.isInteger(p.index) || p.index < 0 || p.index > content.blockOrder.length) {
        throw new CommandError("index is out of range", "invalidIndex");
      }
      index = /** @type {number} */ (p.index);
    }

    content.blocks[block.id] = block;
    content.blockOrder.splice(index, 0, block.id);
    touchPage(tx, page);
  },

  /**
   * Patch a block's fields. Identity and type are preserved.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, patch: Record<string, unknown> }} payload
   */
  updateBlock(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const existing = requireBlock(content, p.blockId);
    if (typeof p.patch !== "object" || p.patch === null || Array.isArray(p.patch)) {
      throw new CommandError("patch must be an object", "invalidBlock");
    }
    const candidate = /** @type {Block} */ ({
      ...existing,
      .../** @type {Record<string, unknown>} */ (p.patch),
      id: existing.id,
      type: existing.type
    });
    const errors = validateBlock(candidate);
    if (errors.length > 0) {
      throw new CommandError(`invalid block update: ${errors.join("; ")}`, "invalidBlock");
    }
    content.blocks[existing.id] = candidate;
    touchPage(tx, page);
  },

  /**
   * Replace a run-capable block's inline runs.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, runs: InlineRun[] }} payload
   */
  setBlockRuns(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const block = requireBlock(content, p.blockId);
    if (!RUN_BLOCK_TYPES.has(block.type)) {
      throw new CommandError(`block type ${block.type} does not carry runs`, "invalidBlock");
    }
    const errors = validateRuns(p.runs);
    if (errors.length > 0) {
      throw new CommandError(`invalid runs: ${errors.join("; ")}`, "invalidRuns");
    }
    block.runs = structuredClone(/** @type {InlineRun[]} */ (p.runs));
    touchPage(tx, page);
  },

  /**
   * Delete a block, removing it from registry and order.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string }} payload
   */
  deleteBlock(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const block = requireBlock(content, p.blockId);
    delete content.blocks[block.id];
    const at = orderIndex(content, block.id);
    if (at !== -1) content.blockOrder.splice(at, 1);
    touchPage(tx, page);
  },

  /**
   * Move a block to a new position in the page order.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, index: number }} payload
   */
  moveBlock(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const block = requireBlock(content, p.blockId);
    const from = orderIndex(content, block.id);
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= content.blockOrder.length) {
      throw new CommandError("index is out of range", "invalidIndex");
    }
    if (from === p.index) return;
    content.blockOrder.splice(from, 1);
    content.blockOrder.splice(/** @type {number} */ (p.index), 0, block.id);
    touchPage(tx, page);
  },

  /**
   * Append a list item to a list block.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, runs?: InlineRun[], index?: number }} payload
   */
  addListItem(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const block = requireBlock(content, p.blockId);
    if (block.type !== "list" || !Array.isArray(block.items)) {
      throw new CommandError("block is not a list", "invalidBlock");
    }
    const runs = p.runs === undefined ? [] : p.runs;
    const errors = validateRuns(runs);
    if (errors.length > 0) {
      throw new CommandError(`invalid runs: ${errors.join("; ")}`, "invalidRuns");
    }
    const item = { id: createId("item"), runs: structuredClone(/** @type {InlineRun[]} */ (runs)) };
    const index = p.index === undefined ? block.items.length : p.index;
    if (!Number.isInteger(index) || index < 0 || index > block.items.length) {
      throw new CommandError("index is out of range", "invalidIndex");
    }
    block.items.splice(/** @type {number} */ (index), 0, item);
    touchPage(tx, page);
  }
};

/**
 * Wire the document command set into a store.
 * @param {Workspace} store
 */
export function registerDocumentCommands(store) {
  for (const [type, handler] of Object.entries(documentCommands)) {
    store.registerCommand(type, handler);
  }
}
