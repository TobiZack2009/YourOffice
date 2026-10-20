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
  BLOCK_TYPES,
  canIndentBlock,
  canOutdentBlock,
  collectDescendants,
  collectItemDescendants,
  createBlock,
  ensureDocumentContent,
  findContainer,
  validateBlock,
  validateRuns
} from "./model.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/store.js").Transaction} Transaction */
/** @typedef {import("./model.js").Block} Block */
/** @typedef {import("./model.js").InlineRun} InlineRun */

const RUN_BLOCK_TYPES = new Set(["paragraph", "heading", "quote"]);

/**
 * Extract plain-text runs from any block, for type conversion.
 * @param {Block} block
 * @returns {InlineRun[]}
 */
function textRunsOf(block) {
  if (Array.isArray(block.runs)) return structuredClone(block.runs);
  if (block.type === "code" && block.text) return [{ text: block.text }];
  if (Array.isArray(block.items)) {
    return block.items.flatMap((item) => structuredClone(item.runs));
  }
  return [];
}

/**
 * Flatten any block to plain text.
 * @param {Block} block
 * @returns {string}
 */
function plainTextOf(block) {
  if (Array.isArray(block.runs)) return block.runs.map((run) => (run.ref ? "" : run.text)).join("");
  if (block.type === "code") return block.text ?? "";
  if (Array.isArray(block.items)) {
    return block.items.map((item) => item.runs.map((run) => (run.ref ? "" : run.text)).join("")).join("\n");
  }
  return "";
}

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
  const page = store._data.pages[id] ?? store._data.detached?.[id];
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

/**
 * Resolve a list item inside a list block or throw.
 * @param {Block} block
 * @param {unknown} itemId
 * @returns {number} Item index.
 */
function requireItemIndex(block, itemId) {
  if (block.type !== "list" || !Array.isArray(block.items)) {
    throw new CommandError("block is not a list", "invalidBlock");
  }
  const id = requireString(itemId, "itemId", "invalidItem");
  const index = block.items.findIndex((item) => item.id === id);
  if (index === -1) throw new CommandError(`list item does not exist: ${id}`, "unknownItem");
  return index;
}

/**
 * Resolve the live container of a block or throw.
 * @param {import("./model.js").DocumentContent} content
 * @param {string} blockId
 * @param {string} [label]
 * @returns {import("./model.js").BlockLocation}
 */
function requireContainer(content, blockId, label = "block") {
  const at = findContainer(content, blockId);
  if (!at) throw new CommandError(`${label} is not in this page`, "unknownBlock");
  return at;
}

/**
 * Resolve an optional new block id supplied by the caller (so UI code that
 * cannot read dispatch results can still find what it created).
 * @param {import("./model.js").DocumentContent} content
 * @param {unknown} value
 * @returns {string | undefined}
 */
function resolveNewBlockId(content, value) {
  if (value === undefined) return undefined;
  const id = requireString(value, "newBlockId", "invalidBlock");
  if (content.blocks[id]) throw new CommandError(`block already exists: ${id}`, "duplicateBlock");
  return id;
}

/**
 * Remove a block and everything nested under it from the registry.
 * @param {import("./model.js").DocumentContent} content
 * @param {string} blockId
 */
function purgeBlock(content, blockId) {
  for (const id of [blockId, ...collectDescendants(content, blockId)]) {
    delete content.blocks[id];
  }
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
    const newId = resolveNewBlockId(content, p.newBlockId);
    if (newId) spec.id = newId;
    const block = createBlock(type, spec);

    /** @type {string[]} */
    let ids = content.blockOrder;
    let index = ids.length;
    if (p.parent !== undefined) {
      const parent = /** @type {Record<string, unknown>} */ (p.parent ?? {});
      const list = requireBlock(content, parent.blockId);
      const item = /** @type {NonNullable<Block["items"]>} */ (list.items)[
        requireItemIndex(list, parent.itemId)
      ];
      item.children ??= [];
      ids = item.children;
      index = ids.length;
    }
    if (p.afterBlockId !== undefined) {
      const at = requireContainer(
        content,
        requireString(p.afterBlockId, "afterBlockId", "invalidBlock"),
        "afterBlockId"
      );
      ids = at.ids;
      index = at.index + 1;
    } else if (p.beforeBlockId !== undefined) {
      const at = requireContainer(
        content,
        requireString(p.beforeBlockId, "beforeBlockId", "invalidBlock"),
        "beforeBlockId"
      );
      ids = at.ids;
      index = at.index;
    } else if (p.index !== undefined) {
      if (!Number.isInteger(p.index) || p.index < 0 || p.index > ids.length) {
        throw new CommandError("index is out of range", "invalidIndex");
      }
      index = /** @type {number} */ (p.index);
    }

    content.blocks[block.id] = block;
    ids.splice(index, 0, block.id);
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
   * Change a block's type, converting its content sensibly (runs ↔ code text ↔
   * list items ↔ nothing). Identity is preserved.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, type: string, fields?: Record<string, unknown> }} payload
   */
  changeBlockType(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const existing = requireBlock(content, p.blockId);
    const type = requireString(p.type, "type", "invalidBlock");
    if (!BLOCK_TYPES.includes(type)) {
      throw new CommandError(`unknown block type: ${type}`, "invalidBlock");
    }
    const fields = /** @type {Record<string, unknown>} */ (
      p.fields && typeof p.fields === "object" ? { ...p.fields } : {}
    );

    if (type === existing.type) {
      // Same type: only flavour fields (heading level, list ordering) may change.
      const patch = {};
      if (type === "heading" && fields.level !== undefined) patch.level = fields.level;
      if (type === "list" && fields.ordered !== undefined) patch.ordered = fields.ordered;
      if (Object.keys(patch).length === 0) return;
      const candidate = { ...existing, ...patch };
      const errors = validateBlock(candidate);
      if (errors.length > 0) {
        throw new CommandError(`invalid block update: ${errors.join("; ")}`, "invalidBlock");
      }
      content.blocks[existing.id] = candidate;
      touchPage(tx, page);
      return;
    }

    const runs = textRunsOf(existing);

    if (RUN_BLOCK_TYPES.has(type)) {
      if (fields.runs === undefined) fields.runs = runs;
      if (type === "heading" && fields.level === undefined) fields.level = 1;
    } else if (type === "list") {
      if (fields.ordered === undefined) {
        fields.ordered = typeof existing.ordered === "boolean" ? existing.ordered : false;
      }
      if (fields.items === undefined) {
        fields.items = [{ id: createId("item"), runs }];
      }
    } else if (type === "code") {
      if (fields.text === undefined) fields.text = plainTextOf(existing);
    }

    // Leaving a list: nested blocks stay in the document as following siblings.
    if (existing.type === "list") {
      const at = requireContainer(content, existing.id);
      const orphans = (existing.items ?? []).flatMap((item) => item.children ?? []);
      at.ids.splice(at.index + 1, 0, ...orphans);
    }

    const created = createBlock(type, fields);
    content.blocks[existing.id] = { ...created, id: existing.id };
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
    const at = findContainer(content, block.id);
    if (at) at.ids.splice(at.index, 1);
    purgeBlock(content, block.id);
    touchPage(tx, page);
  },

  /**
   * Move a block to a new position within its container (the page order, or
   * the children of the list item it is nested under).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, index: number }} payload
   */
  moveBlock(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const block = requireBlock(content, p.blockId);
    const at = requireContainer(content, block.id);
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= at.ids.length) {
      throw new CommandError("index is out of range", "invalidIndex");
    }
    if (at.index === p.index) return;
    at.ids.splice(at.index, 1);
    at.ids.splice(/** @type {number} */ (p.index), 0, block.id);
    touchPage(tx, page);
  },

  /**
   * Move several sibling blocks together, keeping their order, in one step. Unlike repeated
   * `moveBlock` calls the blocks are never seen half-moved, so a section over them keeps its
   * extent. The target is `afterBlockId` / `beforeBlockId` (a block outside the moved set), or
   * `parent` (a list item, default the page) with an `index` counted after the blocks left.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockIds: string[], afterBlockId?: string, beforeBlockId?: string, parent?: { blockId: string, itemId: string }, index?: number }} payload
   */
  moveBlocks(store, tx, payload) {
    const p = /** @type {Record<string, any>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    if (!Array.isArray(p.blockIds) || p.blockIds.length === 0) {
      throw new CommandError("blockIds must be a non-empty array", "invalidBlock");
    }
    const moving = new Set(/** @type {string[]} */ (p.blockIds));
    for (const id of moving) requireBlock(content, id);
    const home = requireContainer(content, p.blockIds[0]);
    for (const id of moving) {
      if (requireContainer(content, id).ids !== home.ids) {
        throw new CommandError("blocks must share a container to move together", "differentContainers");
      }
    }
    const ordered = home.ids.filter((id) => moving.has(id));
    const forbidden = new Set(ordered.flatMap((id) => [id, ...collectDescendants(content, id)]));

    /** @type {string[]} */
    let target;
    /** @type {() => number} */
    let place;
    const anchorId = p.afterBlockId ?? p.beforeBlockId;
    if (anchorId !== undefined) {
      requireString(anchorId, "anchor", "invalidBlock");
      if (forbidden.has(anchorId)) throw new CommandError("cannot move blocks relative to themselves", "invalidIndex");
      const at = requireContainer(content, anchorId, "anchor");
      if (at.parent && forbidden.has(at.parent.blockId)) {
        throw new CommandError("cannot move blocks into themselves", "invalidIndex");
      }
      target = at.ids;
      place = () => target.indexOf(anchorId) + (p.afterBlockId !== undefined ? 1 : 0);
    } else {
      target = content.blockOrder;
      if (p.parent !== undefined) {
        const list = requireBlock(content, p.parent?.blockId);
        if (forbidden.has(list.id)) throw new CommandError("cannot move blocks into themselves", "invalidIndex");
        const item = /** @type {NonNullable<Block["items"]>} */ (list.items)[requireItemIndex(list, p.parent?.itemId)];
        item.children ??= [];
        target = item.children;
      }
      place = () => {
        const index = p.index === undefined ? target.length : p.index;
        if (!Number.isInteger(index) || index < 0 || index > target.length) {
          throw new CommandError("index is out of range", "invalidIndex");
        }
        return index;
      };
    }
    for (const id of ordered) home.ids.splice(home.ids.indexOf(id), 1);
    target.splice(place(), 0, ...ordered);
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
  },

  /**
   * Pull one item out of a list and turn it into a block of another type. The
   * list splits around it; the item's nested blocks follow it as siblings.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, itemId: string, type: string, fields?: Record<string, unknown>, newBlockId?: string }} payload
   */
  extractListItem(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const list = requireBlock(content, p.blockId);
    const itemIndex = requireItemIndex(list, p.itemId);
    const items = /** @type {NonNullable<Block["items"]>} */ (list.items);
    const item = items[itemIndex];
    const type = requireString(p.type, "type", "invalidBlock");
    if (!BLOCK_TYPES.includes(type) || type === "list") {
      throw new CommandError(`cannot extract a list item as ${type}`, "invalidBlock");
    }
    const newId = resolveNewBlockId(content, p.newBlockId);

    const fields = /** @type {Record<string, unknown>} */ (
      p.fields && typeof p.fields === "object" ? { ...p.fields } : {}
    );
    if (RUN_BLOCK_TYPES.has(type)) {
      if (fields.runs === undefined) fields.runs = structuredClone(item.runs);
      if (type === "heading" && fields.level === undefined) fields.level = 1;
    } else if (type === "code" && fields.text === undefined) {
      fields.text = item.runs.map((run) => (run.ref ? "" : run.text)).join("");
    }
    if (newId) fields.id = newId;
    const created = createBlock(type, fields);

    const before = items.slice(0, itemIndex);
    const after = items.slice(itemIndex + 1);
    const at = requireContainer(content, list.id);
    content.blocks[created.id] = created;

    /** @type {string[]} */
    const replacement = [];
    if (before.length > 0) {
      list.items = before;
      replacement.push(list.id);
    }
    replacement.push(created.id, ...(item.children ?? []));
    if (after.length > 0) {
      if (before.length > 0) {
        const tail = createBlock("list", { ordered: list.ordered, items: after });
        content.blocks[tail.id] = tail;
        replacement.push(tail.id);
      } else {
        list.items = after;
        replacement.push(list.id);
      }
    } else if (before.length === 0) {
      delete content.blocks[list.id];
    }
    at.ids.splice(at.index, 1, ...replacement);
    touchPage(tx, page);
  },

  /**
   * Delete one list item together with everything nested under it. A list
   * left without items is removed.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, itemId: string }} payload
   */
  deleteListItem(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const list = requireBlock(content, p.blockId);
    const itemIndex = requireItemIndex(list, p.itemId);
    const items = /** @type {NonNullable<Block["items"]>} */ (list.items);
    const [item] = items.splice(itemIndex, 1);
    for (const id of [...(item.children ?? []), ...collectItemDescendants(content, item)]) {
      delete content.blocks[id];
    }
    if (items.length === 0) {
      const at = findContainer(content, list.id);
      if (at) at.ids.splice(at.index, 1);
      delete content.blocks[list.id];
    }
    touchPage(tx, page);
  },

  /**
   * Nest a list item under its previous sibling.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, itemId: string }} payload
   */
  indentListItem(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const list = requireBlock(content, p.blockId);
    const itemIndex = requireItemIndex(list, p.itemId);
    if (itemIndex === 0) {
      throw new CommandError("the first list item cannot be indented", "cannotIndent");
    }
    const items = /** @type {NonNullable<Block["items"]>} */ (list.items);
    const [item] = items.splice(itemIndex, 1);
    const previous = items[itemIndex - 1];
    previous.children ??= [];
    const lastId = previous.children[previous.children.length - 1];
    const last = lastId ? content.blocks[lastId] : undefined;
    if (last?.type === "list" && last.ordered === list.ordered) {
      /** @type {NonNullable<Block["items"]>} */ (last.items).push(item);
    } else {
      const nested = createBlock("list", { ordered: list.ordered, items: [item] });
      content.blocks[nested.id] = nested;
      previous.children.push(nested.id);
    }
    touchPage(tx, page);
  },

  /**
   * Lift a list item one level. A nested item moves into the parent list right
   * after its parent item and adopts its later siblings; a top-level item
   * becomes a paragraph.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string, itemId: string, newBlockId?: string }} payload
   */
  outdentListItem(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const list = requireBlock(content, p.blockId);
    const itemIndex = requireItemIndex(list, p.itemId);
    const items = /** @type {NonNullable<Block["items"]>} */ (list.items);
    const at = requireContainer(content, list.id);

    if (!at.parent) {
      documentCommands.extractListItem(store, tx, {
        pageId: p.pageId,
        blockId: list.id,
        itemId: items[itemIndex].id,
        type: "paragraph",
        newBlockId: p.newBlockId
      });
      return;
    }

    const parentList = requireBlock(content, at.parent.blockId);
    const parentItems = /** @type {NonNullable<Block["items"]>} */ (parentList.items);
    const parentIndex = requireItemIndex(parentList, at.parent.itemId);
    const parentItem = parentItems[parentIndex];

    const later = items.splice(itemIndex + 1);
    const [item] = items.splice(itemIndex, 1);
    if (later.length > 0) {
      const adopted = createBlock("list", { ordered: list.ordered, items: later });
      content.blocks[adopted.id] = adopted;
      item.children = [...(item.children ?? []), adopted.id];
    }
    if (items.length === 0) {
      parentItem.children = (parentItem.children ?? []).filter((id) => id !== list.id);
      delete content.blocks[list.id];
    }
    parentItems.splice(parentIndex + 1, 0, item);
    touchPage(tx, page);
  },

  /**
   * Nest a block under the last item of the list directly above it.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string }} payload
   */
  indentBlock(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const block = requireBlock(content, p.blockId);
    if (!canIndentBlock(content, block.id)) {
      throw new CommandError("block cannot be indented", "cannotIndent");
    }
    const at = requireContainer(content, block.id);
    const previous = /** @type {Block} */ (content.blocks[at.ids[at.index - 1]]);
    const items = /** @type {NonNullable<Block["items"]>} */ (previous.items);
    const target = items[items.length - 1];
    at.ids.splice(at.index, 1);
    target.children ??= [];
    target.children.push(block.id);
    touchPage(tx, page);
  },

  /**
   * Lift a nested block out of its list item. The block and its later siblings
   * land after the list (split at the parent item) so reading order is kept.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, blockId: string }} payload
   */
  outdentBlock(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireDocumentPage(store, p.pageId);
    const block = requireBlock(content, p.blockId);
    if (!canOutdentBlock(content, block.id)) {
      throw new CommandError("block is not nested", "cannotOutdent");
    }
    const at = requireContainer(content, block.id);
    const parent = /** @type {{ blockId: string, itemId: string }} */ (at.parent);
    const list = requireBlock(content, parent.blockId);
    const items = /** @type {NonNullable<Block["items"]>} */ (list.items);
    const parentIndex = requireItemIndex(list, parent.itemId);
    const moved = at.ids.splice(at.index);
    const outer = requireContainer(content, list.id);

    const replacement = [...moved];
    const rest = items.slice(parentIndex + 1);
    if (rest.length > 0) {
      list.items = items.slice(0, parentIndex + 1);
      const tail = createBlock("list", { ordered: list.ordered, items: rest });
      content.blocks[tail.id] = tail;
      replacement.push(tail.id);
    }
    outer.ids.splice(outer.index + 1, 0, ...replacement);
    touchPage(tx, page);
  }
};

/** Commands that cannot add or remove structure others depend on; hooks skip their heavy checks for them. */
const DOCUMENT_HOT = new Set(["setBlockRuns", "updateBlock"]);

/**
 * Wire the document command set into a store.
 * @param {Workspace} store
 */
export function registerDocumentCommands(store) {
  for (const [type, handler] of Object.entries(documentCommands)) {
    store.registerCommand(type, handler, { hot: DOCUMENT_HOT.has(type) });
  }
}
