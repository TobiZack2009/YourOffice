/**
 * Blocks as clipboard data: a pure model of what a copy carries, with no DOM and no commands.
 *
 * A fragment is the selected units cut out of a document: whole blocks, the partial text of the
 * two end blocks, and (for list items) the nested blocks that were selected with them. It travels
 * as JSON under a private MIME type so a paste inside the app keeps structure and marks, and as
 * plain text for everything else.
 */

import { createId } from "../core/ids.js";
import { BLOCK_TYPES } from "../document/model.js";
import { splitRunsAt } from "./block-runs.js";
import { mergeRuns } from "./inline.js";

/** Private clipboard format for a fragment. */
export const FRAGMENT_MIME = "application/x-youroffice-blocks";

const RUN_TYPES = new Set(["paragraph", "heading", "quote"]);
const MAX_BLOCKS = 5000;

/** @typedef {import("../document/model.js").Block} Block */
/** @typedef {import("../document/model.js").InlineRun} InlineRun */
/** @typedef {{ blockId: string, itemId: string | null, start: number, end: number | null }} UnitSlice `end` null means the whole unit. */
/** @typedef {{ version: 1, blocks: Block[], descendants: Record<string, Block> }} Fragment */
/** @typedef {{ blockId: string, spec: Record<string, any>, parent: { blockId: string, itemId: string } | null }} PlanStep */

/**
 * The runs between two text offsets.
 * @param {InlineRun[]} runs
 * @param {number} start
 * @param {number} end
 * @returns {InlineRun[]}
 */
export function sliceRuns(runs, start, end) {
  return splitRunsAt(splitRunsAt(runs, start).right, end - start).left;
}

/** @param {UnitSlice} slice @param {InlineRun[]} runs */
const runsOfSlice = (slice, runs) => (slice.end === null ? structuredClone(runs) : sliceRuns(runs, slice.start, slice.end));

/**
 * Cut the given units out of a document.
 * @param {{ blocks: Record<string, Block> }} content
 * @param {UnitSlice[]} units In reading order.
 * @returns {Fragment}
 */
export function sliceUnits(content, units) {
  /** @type {Map<string, UnitSlice>} */
  const slices = new Map(units.map((unit) => [unit.itemId ? `${unit.blockId}:${unit.itemId}` : unit.blockId, unit]));
  const withUnits = new Set(units.map((unit) => unit.blockId));
  /** @type {Set<string>} */
  const consumed = new Set();
  /** @type {Record<string, Block>} */
  const descendants = {};

  /** @param {Block} block @returns {Block} */
  function take(block) {
    consumed.add(block.id);
    if (block.type === "list") {
      /** @type {NonNullable<Block["items"]>} */
      const items = [];
      for (const item of block.items ?? []) {
        const slice = slices.get(`${block.id}:${item.id}`);
        if (!slice) continue;
        /** @type {NonNullable<Block["items"]>[number]} */
        const copy = { id: item.id, runs: runsOfSlice(slice, item.runs ?? []) };
        // A whole item brings the blocks nested under it that were selected too.
        const kids = slice.end === null ? (item.children ?? []).filter((id) => withUnits.has(id) && content.blocks[id]) : [];
        if (kids.length > 0) {
          copy.children = kids;
          for (const id of kids) descendants[id] = take(content.blocks[id]);
        }
        items.push(copy);
      }
      return { ...structuredClone({ ...block, items: [] }), items };
    }
    const slice = slices.get(block.id);
    if (slice && slice.end !== null) {
      if (block.type === "code") return { ...structuredClone(block), text: (block.text ?? "").slice(slice.start, slice.end) };
      if (RUN_TYPES.has(block.type)) return { ...structuredClone(block), runs: sliceRuns(block.runs ?? [], slice.start, slice.end) };
    }
    return structuredClone(block);
  }

  /** @type {Block[]} */
  const blocks = [];
  for (const unit of units) {
    const block = content.blocks[unit.blockId];
    if (!block || consumed.has(block.id)) continue;
    blocks.push(take(block));
  }
  return { version: 1, blocks, descendants };
}

/**
 * Read clipboard JSON, refusing anything that is not a fragment.
 * @param {string} text
 * @returns {Fragment | null}
 */
export function readFragment(text) {
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || value.version !== 1 || !Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS) return null;
  const descendants = value.descendants && typeof value.descendants === "object" ? value.descendants : {};
  const sound = (/** @type {any} */ block) => block && typeof block === "object" && BLOCK_TYPES.includes(block.type);
  if (!value.blocks.every(sound) || !Object.values(descendants).every(sound)) return null;
  return { version: 1, blocks: value.blocks, descendants };
}

/**
 * New ids for a fragment, as the inserts that bring it into a document, parents first.
 * @param {Fragment} fragment
 * @returns {PlanStep[]}
 */
export function planFragment(fragment) {
  /** @type {PlanStep[]} */
  const plan = [];
  /** @param {Block} block @param {PlanStep["parent"]} parent */
  const add = (block, parent) => {
    const blockId = createId("block");
    const spec = /** @type {Record<string, any>} */ (structuredClone(block));
    delete spec.id;
    /** @type {[string, string[]][]} */
    const nested = [];
    if (Array.isArray(spec.items)) {
      spec.items = spec.items.map((/** @type {any} */ item) => {
        const { children, ...rest } = item;
        const next = { ...rest, id: createId("item") };
        if (Array.isArray(children) && children.length > 0) nested.push([next.id, children]);
        return next;
      });
    }
    plan.push({ blockId, spec, parent });
    for (const [itemId, ids] of nested) {
      for (const id of ids) {
        const child = fragment.descendants[id];
        if (child) add(child, { blockId, itemId });
      }
    }
  };
  for (const block of fragment.blocks) add(block, null);
  return plan;
}

/**
 * The text of a single textual block, when the fragment is nothing more than that.
 * @param {Fragment} fragment
 * @returns {InlineRun[] | null}
 */
export function inlineRunsOf(fragment) {
  if (fragment.blocks.length !== 1) return null;
  const [block] = fragment.blocks;
  if (RUN_TYPES.has(block.type)) return block.runs ?? [];
  if (block.type === "list" && block.items?.length === 1 && !block.items[0].children) return block.items[0].runs ?? [];
  if (block.type === "code") return block.text ? [{ text: block.text }] : [];
  return null;
}

/**
 * @param {InlineRun[]} runs
 * @returns {string}
 */
const runsText = (runs) => runs.map((run) => (run.ref ? (run.ref.expression ?? "") : run.text)).join("");

/**
 * A fragment as plain text.
 * @param {Fragment} fragment
 * @param {{ pageTitle?: (pageId: string) => string | undefined }} [options]
 * @returns {string}
 */
export function fragmentText(fragment, options = {}) {
  const single = inlineRunsOf(fragment);
  if (single) return runsText(single);

  /** @param {Block} block @param {string} indent @returns {string} */
  const lines = (block, indent) => {
    switch (block.type) {
      case "list": {
        const out = [];
        (block.items ?? []).forEach((item, index) => {
          out.push(`${indent}${block.ordered ? `${index + 1}.` : "-"} ${runsText(item.runs ?? [])}`);
          for (const id of item.children ?? []) {
            const child = fragment.descendants[id];
            if (child) out.push(lines(child, `${indent}  `));
          }
        });
        return out.join("\n");
      }
      case "code":
        return block.text ?? "";
      case "divider":
        return "---";
      case "image":
        return block.alt ?? "";
      case "pageLink":
        return (block.pageId && options.pageTitle?.(block.pageId)) || "";
      case "paragraph":
      case "heading":
      case "quote":
        return indent + runsText(block.runs ?? []);
      default:
        return "";
    }
  };
  return fragment.blocks.map((block) => lines(block, "")).join("\n\n");
}

/**
 * Plain text as paragraphs, one per non-empty line.
 * @param {string} text
 * @returns {Fragment}
 */
export function textToFragment(text) {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => /** @type {Block} */ ({ id: createId("block"), type: "paragraph", runs: mergeRuns([{ text: line }]) }));
  return { version: 1, blocks, descendants: {} };
}
