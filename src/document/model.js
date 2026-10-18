/**
 * Document block model (spec §5.2).
 *
 * A document page's content is:
 *
 *   { blockOrder: string[], blocks: { [id]: Block } }
 *
 * Ordering lives in `blockOrder`, identity in `blocks` — matching the page
 * registry/hierarchy split at the workspace level (spec §5.2: ordering is
 * represented independently of block identity). Rich text is a list of inline
 * runs; each run carries optional marks. Blocks are plain data; renderers are
 * pure functions of this data.
 *
 * Reference-style blocks (section ref, sheet embed, slide ref) are modelled now
 * so content round-trips, but their resolution lands in Phase 6.
 */

import { createId } from "../core/ids.js";
import { CommandError } from "../core/errors.js";

/** @type {string[]} Block types accepted in content today. */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "list",
  "quote",
  "code",
  "divider",
  "image",
  "pageLink",
  "sectionRef",
  "sheetEmbed",
  "slideRef"
];

const MARK_KEYS = new Set(["bold", "italic", "underline", "strike", "code", "link"]);
const ALIGNMENTS = new Set(["left", "center", "right"]);

/**
 * A run of inline text with optional formatting marks.
 * @typedef {object} InlineRun
 * @property {string} text
 * @property {{ bold?: boolean, italic?: boolean, underline?: boolean, strike?: boolean, code?: boolean, link?: string }} [marks]
 * @property {{ id: string, kind?: "embed" | "expression", sectionId?: string, expression?: string, display?: Record<string, any> }} [ref]
 *   Set on a reference run: an atomic inline embed or expression whose `text` is `REF_CHAR`.
 */

/**
 * @typedef {object} Block
 * @property {string} id
 * @property {string} type
 * @property {InlineRun[]} [runs]
 * @property {number} [level]
 * @property {boolean} [ordered]
 * @property {{ id: string, runs: InlineRun[], children?: string[] }[]} [items]
 * @property {string} [language]
 * @property {string} [text]
 * @property {string} [assetId]
 * @property {string} [alt]
 * @property {number | null} [width]
 * @property {string} [align]
 * @property {string} [pageId]
 * @property {string} [sectionId]
 * @property {"embed" | "expression"} [kind] Reference blocks: embed (default) or expression.
 * @property {string} [expression]
 * @property {Record<string, any>} [display]
 * @property {string} [tableId]
 * @property {string} [slideId]
 */

/** @typedef {{ blockOrder: string[], blocks: Record<string, Block> }} DocumentContent */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stands in for an inline reference in a run's `text`, so every offset counts it as one character. */
export const REF_CHAR = "\uFFFC";

/**
 * Validate an inline run list.
 * @param {unknown} runs
 * @returns {string[]} error messages (empty when valid).
 */
export function validateRuns(runs) {
  /** @type {string[]} */
  const errors = [];
  if (!Array.isArray(runs)) {
    return ["runs must be an array"];
  }
  runs.forEach((run, index) => {
    if (!isPlainObject(run)) {
      errors.push(`runs[${index}] must be an object`);
      return;
    }
    if (typeof run.text !== "string") {
      errors.push(`runs[${index}].text must be a string`);
    } else if (run.text.length === 0) {
      errors.push(`runs[${index}].text must not be empty`);
    }
    if (run.ref !== undefined) {
      // A reference run is atomic: one placeholder character, no marks.
      if (run.text !== REF_CHAR) errors.push(`runs[${index}] is a reference, its text must be the placeholder character`);
      if (run.marks !== undefined) errors.push(`runs[${index}] is a reference and cannot carry marks`);
      if (!isPlainObject(run.ref) || typeof run.ref.id !== "string" || run.ref.id.length === 0) {
        errors.push(`runs[${index}].ref.id must be a non-empty string`);
      } else {
        errors.push(...validateReferenceFields(run.ref).map((e) => `runs[${index}].${e}`));
      }
      return;
    }
    if (run.marks !== undefined) {
      if (!isPlainObject(run.marks)) {
        errors.push(`runs[${index}].marks must be an object`);
      } else {
        for (const [key, value] of Object.entries(run.marks)) {
          if (!MARK_KEYS.has(key)) {
            errors.push(`runs[${index}].marks has unknown mark "${key}"`);
          } else if (key === "link") {
            if (typeof value !== "string" || value.length === 0) {
              errors.push(`runs[${index}].marks.link must be a non-empty string`);
            }
          } else if (typeof value !== "boolean") {
            errors.push(`runs[${index}].marks.${key} must be a boolean`);
          }
        }
      }
    }
  });
  return errors;
}

/**
 * Fields shared by every reference instance (a block, an inline run or a slide object):
 * an embed names a section; an expression carries formula text. `display` is free-form
 * instance-local presentation (size, alignment, crop).
 * @param {Record<string, any>} record
 * @returns {string[]}
 */
export function validateReferenceFields(record) {
  /** @type {string[]} */
  const errors = [];
  const kind = record.kind ?? "embed";
  if (kind !== "embed" && kind !== "expression") {
    errors.push("reference.kind must be embed or expression");
  } else if (kind === "embed") {
    if (typeof record.sectionId !== "string" || record.sectionId.length === 0) {
      errors.push("sectionRef.sectionId must be a non-empty string");
    }
  } else if (typeof record.expression !== "string") {
    errors.push("reference.expression must be a string");
  }
  if (record.display !== undefined && !isPlainObject(record.display)) {
    errors.push("reference.display must be an object");
  }
  return errors;
}

/**
 * Validate a single block.
 * @param {unknown} block
 * @returns {string[]} error messages (empty when valid).
 */
export function validateBlock(block) {
  if (!isPlainObject(block)) return ["block must be an object"];
  /** @type {string[]} */
  const errors = [];
  if (typeof block.id !== "string" || block.id.length === 0) {
    errors.push("block.id must be a non-empty string");
  }
  if (typeof block.type !== "string" || !BLOCK_TYPES.includes(block.type)) {
    errors.push(`block.type must be one of ${BLOCK_TYPES.join(", ")}`);
    return errors;
  }

  const prefix = `blocks["${block.id}"]`;

  switch (block.type) {
    case "paragraph":
    case "quote":
      errors.push(...validateRuns(block.runs ?? []).map((e) => `${prefix}: ${e}`));
      break;
    case "heading": {
      const level = block.level;
      if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 3) {
        errors.push(`${prefix}: heading level must be an integer 1–3`);
      }
      errors.push(...validateRuns(block.runs ?? []).map((e) => `${prefix}: ${e}`));
      break;
    }
    case "list": {
      if (typeof block.ordered !== "boolean") {
        errors.push(`${prefix}: list.ordered must be a boolean`);
      }
      if (!Array.isArray(block.items)) {
        errors.push(`${prefix}: list.items must be an array`);
      } else {
        block.items.forEach((item, index) => {
          if (!isPlainObject(item) || typeof item.id !== "string" || item.id.length === 0) {
            errors.push(`${prefix}: list.items[${index}].id must be a non-empty string`);
            return;
          }
          errors.push(
            ...validateRuns(item.runs).map((e) => `${prefix}: list.items[${index}]: ${e}`)
          );
          if (item.children !== undefined) {
            if (
              !Array.isArray(item.children) ||
              item.children.some((child) => typeof child !== "string" || child.length === 0)
            ) {
              errors.push(`${prefix}: list.items[${index}].children must be an array of block ids`);
            }
          }
        });
      }
      break;
    }
    case "code":
      if (typeof block.text !== "string") {
        errors.push(`${prefix}: code.text must be a string`);
      }
      if (block.language !== undefined && typeof block.language !== "string") {
        errors.push(`${prefix}: code.language must be a string`);
      }
      break;
    case "divider":
      break;
    case "image":
      if (typeof block.assetId !== "string" || block.assetId.length === 0) {
        errors.push(`${prefix}: image.assetId must be a non-empty string`);
      }
      if (block.width !== undefined && block.width !== null) {
        if (typeof block.width !== "number" || block.width <= 0) {
          errors.push(`${prefix}: image.width must be a positive number or null`);
        }
      }
      if (block.align !== undefined && !ALIGNMENTS.has(block.align)) {
        errors.push(`${prefix}: image.align must be one of left, center, right`);
      }
      if (block.alt !== undefined && typeof block.alt !== "string") {
        errors.push(`${prefix}: image.alt must be a string`);
      }
      break;
    case "pageLink":
      if (typeof block.pageId !== "string" || block.pageId.length === 0) {
        errors.push(`${prefix}: pageLink.pageId must be a non-empty string`);
      }
      break;
    case "sectionRef":
      errors.push(...validateReferenceFields(block).map((e) => `${prefix}: ${e}`));
      break;
    case "sheetEmbed":
      if (typeof block.pageId !== "string" || block.pageId.length === 0) {
        errors.push(`${prefix}: sheetEmbed.pageId must be a non-empty string`);
      }
      if (block.tableId !== undefined && typeof block.tableId !== "string") {
        errors.push(`${prefix}: sheetEmbed.tableId must be a string`);
      }
      break;
    case "slideRef":
      if (typeof block.pageId !== "string" || block.pageId.length === 0) {
        errors.push(`${prefix}: slideRef.pageId must be a non-empty string`);
      }
      if (block.slideId !== undefined && typeof block.slideId !== "string") {
        errors.push(`${prefix}: slideRef.slideId must be a string`);
      }
      break;
    default:
      break;
  }

  return errors;
}

/**
 * Validate a whole document content object.
 * @param {unknown} content
 * @returns {string[]} error messages (empty when valid).
 */
export function validateDocumentContent(content) {
  if (!isPlainObject(content)) return ["content must be an object"];
  /** @type {string[]} */
  const errors = [];

  if (!Array.isArray(content.blockOrder)) {
    errors.push("blockOrder must be an array");
  }
  if (!isPlainObject(content.blocks)) {
    errors.push("blocks must be an object");
  }
  if (errors.length > 0) return errors;

  const order = /** @type {string[]} */ (content.blockOrder);
  const blocks = /** @type {Record<string, unknown>} */ (content.blocks);

  const seen = new Set();
  for (const id of order) {
    if (typeof id !== "string") {
      errors.push("blockOrder must contain only strings");
      continue;
    }
    if (seen.has(id)) errors.push(`blockOrder lists "${id}" more than once`);
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(blocks, id)) {
      errors.push(`blockOrder references missing block "${id}"`);
    }
  }

  // Blocks nested under list items are reachable through `item.children`.
  const pending = [...order];
  while (pending.length > 0) {
    const id = /** @type {string} */ (pending.pop());
    const block = blocks[id];
    if (!isPlainObject(block) || !Array.isArray(block.items)) continue;
    for (const item of block.items) {
      if (!isPlainObject(item) || !Array.isArray(item.children)) continue;
      for (const childId of item.children) {
        if (typeof childId !== "string") continue;
        if (seen.has(childId)) {
          errors.push(`block "${childId}" is referenced more than once`);
          continue;
        }
        seen.add(childId);
        if (!Object.prototype.hasOwnProperty.call(blocks, childId)) {
          errors.push(`list item "${item.id}" references missing block "${childId}"`);
          continue;
        }
        pending.push(childId);
      }
    }
  }

  for (const [id, block] of Object.entries(blocks)) {
    if (!isPlainObject(block) || block.id !== id) {
      errors.push(`blocks["${id}"].id must match its key`);
    }
    errors.push(...validateBlock(block));
    if (!seen.has(id)) {
      errors.push(`block "${id}" is not reachable from blockOrder`);
    }
  }

  return errors;
}

/**
 * Create an empty document content object.
 * @returns {DocumentContent}
 */
export function createDocumentContent() {
  return { blockOrder: [], blocks: {} };
}

/**
 * Create a validated block of the given type.
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 * @returns {Block}
 * @throws {import("../core/errors.js").CommandError} When the block is invalid.
 */
export function createBlock(type, fields = {}) {
  const block = /** @type {Block} */ ({
    id: createId("block"),
    type,
    // Deep copy so the caller's arrays (runs, items) are never shared with the store.
    ...structuredClone(fields)
  });

  if (type === "paragraph" || type === "quote" || type === "heading") {
    if (!Array.isArray(block.runs)) block.runs = [];
  }
  if (type === "code" && typeof block.text !== "string") {
    block.text = "";
  }
  if (type === "image") {
    if (block.width === undefined) block.width = null;
    if (block.align === undefined) block.align = "center";
  }
  if (type === "list") {
    if (typeof block.ordered !== "boolean") block.ordered = false;
    // A list always has at least one item, otherwise there is nothing to type in.
    if (!Array.isArray(block.items) || block.items.length === 0) {
      block.items = [createListItem()];
    }
  }

  const errors = validateBlock(block);
  if (errors.length > 0) {
    throw new CommandError(`invalid ${type} block: ${errors.join("; ")}`, "invalidBlock");
  }
  return block;
}

/**
 * Create a list item with a stable id.
 * @param {InlineRun[]} [runs]
 * @returns {{ id: string, runs: InlineRun[] }}
 */
export function createListItem(runs = []) {
  return { id: createId("item"), runs };
}

/**
 * Where a block lives: the root order, or the children of a list item.
 * @typedef {object} BlockLocation
 * @property {string[]} ids The containing id array (live reference).
 * @property {{ blockId: string, itemId: string } | null} parent null at the root.
 * @property {number} index Position inside `ids`.
 */

/**
 * Find the container array holding a block.
 * @param {DocumentContent} content
 * @param {string} blockId
 * @returns {BlockLocation | null}
 */
export function findContainer(content, blockId) {
  const rootIndex = content.blockOrder.indexOf(blockId);
  if (rootIndex !== -1) return { ids: content.blockOrder, parent: null, index: rootIndex };
  for (const block of Object.values(content.blocks)) {
    if (block.type !== "list") continue;
    for (const item of block.items ?? []) {
      const index = item.children ? item.children.indexOf(blockId) : -1;
      if (index !== -1) {
        return {
          ids: /** @type {string[]} */ (item.children),
          parent: { blockId: block.id, itemId: item.id },
          index
        };
      }
    }
  }
  return null;
}

/**
 * Collect every block id nested (at any depth) under the given block.
 * @param {DocumentContent} content
 * @param {string} blockId
 * @returns {string[]}
 */
export function collectDescendants(content, blockId) {
  /** @type {string[]} */
  const out = [];
  const visit = (id) => {
    const block = content.blocks[id];
    if (!block || block.type !== "list") return;
    for (const item of block.items ?? []) {
      for (const childId of item.children ?? []) {
        out.push(childId);
        visit(childId);
      }
    }
  };
  visit(blockId);
  return out;
}

/**
 * Collect every block id nested under one list item.
 * @param {DocumentContent} content
 * @param {{ children?: string[] }} item
 * @returns {string[]}
 */
export function collectItemDescendants(content, item) {
  /** @type {string[]} */
  const out = [];
  for (const childId of item.children ?? []) {
    out.push(childId, ...collectDescendants(content, childId));
  }
  return out;
}

/**
 * Whether a block can be indented: its previous sibling must be a list.
 * @param {DocumentContent} content
 * @param {string} blockId
 * @returns {boolean}
 */
export function canIndentBlock(content, blockId) {
  const at = findContainer(content, blockId);
  if (!at || at.index === 0) return false;
  const previous = content.blocks[at.ids[at.index - 1]];
  return previous?.type === "list" && (previous.items?.length ?? 0) > 0;
}

/**
 * Whether a block can be outdented: it must live under a list item.
 * @param {DocumentContent} content
 * @param {string} blockId
 * @returns {boolean}
 */
export function canOutdentBlock(content, blockId) {
  return findContainer(content, blockId)?.parent != null;
}

/**
 * Whether a list item can be indented (it needs a previous sibling item).
 * @param {DocumentContent} content
 * @param {string} blockId
 * @param {string} itemId
 * @returns {boolean}
 */
export function canIndentItem(content, blockId, itemId) {
  const block = content.blocks[blockId];
  if (block?.type !== "list") return false;
  return (block.items ?? []).findIndex((item) => item.id === itemId) > 0;
}

/**
 * Ensure a page envelope has document content, initialising it when absent.
 * @param {import("../workspace/schema.js").PageEnvelope} page
 * @returns {DocumentContent}
 */
export function ensureDocumentContent(page) {
  const content = /** @type {DocumentContent | undefined} */ (page.content);
  if (!content || !Array.isArray(content.blockOrder) || !isPlainObject(content.blocks)) {
    const fresh = createDocumentContent();
    page.content = /** @type {Record<string, unknown>} */ (fresh);
    return fresh;
  }
  return content;
}
