/**
 * Operations on the units picked by block selection: delete, change type, restyle runs.
 * State shared with the editor arrives through the `ed` kernel.
 */

import { createId } from "../core/ids.js";
import { mergeRuns } from "./inline.js";

const RUN_TYPES = new Set(["paragraph", "heading", "quote"]);
const TEXTUAL_TYPES = new Set(["paragraph", "heading", "quote", "list", "code"]);

/** @typedef {import("../document/model.js").InlineRun} InlineRun */

/** @param {any} ed Editor kernel (see `createDocumentEditor`). */
export function createBlockSelectionOps(ed) {
  const { workspace, nested, pageId, dispatch, render, order, blockOf, locateItem, parseKey, unitKey, unitKeys, unitElement } = ed;
  const { editableOfUnit, focusKey, keyOfBlock, selectedKeys, setBlockSelection, notifyActiveChange } = ed;

  /** Delete every selected unit as one undoable step. */
  function deleteSelection() {
    const keys = selectedKeys();
    if (keys.length === 0) return;
    const all = unitKeys();
    const before = all.slice(0, all.indexOf(keys[0])).reverse();
    const after = all.slice(all.indexOf(keys[keys.length - 1]) + 1);
    const fallbackId = createId("block");

    workspace.transact("delete selection", () => {
      if (nested) {
        // An embed must keep a block to type in: add one after the run before it empties.
        const doomed = new Set(keys.filter((key) => !parseKey(key).itemId).map((key) => parseKey(key).blockId));
        const run = order();
        if (run.length > 0 && run.every((id) => doomed.has(id))) {
          dispatch("insertBlock", {
            pageId,
            block: { type: "paragraph" },
            newBlockId: fallbackId,
            afterBlockId: run[run.length - 1]
          });
        }
      }
      // Reverse reading order removes nested units before the units that hold them.
      for (const key of [...keys].reverse()) {
        const { blockId, itemId } = parseKey(key);
        const block = blockOf(blockId);
        if (!block) continue;
        if (itemId) {
          if ((block.items ?? []).some((item) => item.id === itemId)) {
            dispatch("deleteListItem", { pageId, blockId, itemId });
          }
        } else {
          dispatch("deleteBlock", { pageId, blockId });
        }
      }
      if (!nested && order().length === 0) {
        dispatch("insertBlock", {
          pageId,
          block: { type: "paragraph" },
          newBlockId: fallbackId
        });
      }
    });

    ed.dropSelection();
    render();
    const target = [...before, ...after].find((key) => editableOfUnit(unitElement(key)));
    if (!(target && focusKey(target, before.includes(target) ? "end" : "start"))) {
      const first = unitKeys().find((key) => editableOfUnit(unitElement(key)));
      if (first) focusKey(first, "start");
    }
  }

  /**
   * Apply a block type to every selected unit.
   * @param {{ type: string, level?: number, ordered?: boolean }} spec
   */
  function applyTypeToSelection(spec) {
    const keys = selectedKeys();
    /** @type {Record<string, unknown>} */
    const fields = {};
    if (spec.level !== undefined) fields.level = spec.level;
    if (spec.ordered !== undefined) fields.ordered = spec.ordered;
    /** @type {string[]} */
    const resulting = [];

    workspace.transact("change block type", () => {
      for (const key of keys) {
        const { blockId, itemId } = parseKey(key);
        if (itemId) {
          const hit = locateItem(itemId);
          if (!hit) continue;
          if (spec.type === "list") {
            if (spec.ordered !== undefined && spec.ordered !== Boolean(hit.block.ordered)) {
              dispatch("updateBlock", {
                pageId,
                blockId: hit.block.id,
                patch: { ordered: spec.ordered }
              });
            }
            resulting.push(unitKey(hit.block.id, itemId));
          } else {
            const newBlockId = createId("block");
            dispatch("extractListItem", {
              pageId,
              blockId: hit.block.id,
              itemId,
              type: spec.type,
              fields: spec.level !== undefined ? { level: spec.level } : {},
              newBlockId
            });
            resulting.push(newBlockId);
          }
          continue;
        }
        const block = blockOf(blockId);
        if (!block || !TEXTUAL_TYPES.has(block.type)) continue;
        dispatch("changeBlockType", { pageId, blockId, type: spec.type, fields });
        resulting.push(keyOfBlock(blockId));
      }
    });

    render();
    if (resulting.length > 0) setBlockSelection(resulting[0], resulting[resulting.length - 1]);
  }

  /**
   * Rewrite the runs of every selected text unit in one transaction.
   * @param {string} label Transaction label.
   * @param {(allRuns: InlineRun[]) => ((runs: InlineRun[]) => InlineRun[])} plan
   *   Sees every selected run first (to decide add vs remove), returns the per-unit rewrite.
   * @returns {boolean}
   */
  function transformSelectedRuns(label, plan) {
    const targets = selectedKeys()
      .map((key) => {
        const { blockId, itemId } = parseKey(key);
        const block = blockOf(blockId);
        if (!block) return null;
        if (itemId) {
          const hit = locateItem(itemId);
          return hit ? { blockId: hit.block.id, itemId, runs: hit.item.runs ?? [] } : null;
        }
        return RUN_TYPES.has(block.type) ? { blockId, itemId: null, runs: block.runs ?? [] } : null;
      })
      .filter((target) => target !== null);
    const allRuns = targets.flatMap((target) => target.runs);
    if (allRuns.length === 0) return false;
    const restyle = plan(allRuns);

    workspace.transact(label, () => {
      for (const target of targets) {
        if (target.itemId) {
          const hit = locateItem(target.itemId);
          if (!hit) continue;
          const items = (hit.block.items ?? []).map((item) =>
            item.id === target.itemId ? { ...item, runs: restyle(item.runs ?? []) } : item
          );
          dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
        } else {
          const block = blockOf(target.blockId);
          if (block) {
            dispatch("setBlockRuns", {
              pageId,
              blockId: target.blockId,
              runs: restyle(block.runs ?? [])
            });
          }
        }
      }
    });
    render();
    notifyActiveChange();
    return true;
  }

  /**
   * Toggle an inline mark across every selected text unit.
   * @param {"bold" | "italic" | "underline" | "strike" | "code"} mark
   * @returns {boolean}
   */
  function toggleMarkOnSelection(mark) {
    return transformSelectedRuns(`toggle ${mark}`, (allRuns) => {
      const remove = allRuns.every((run) => run.marks?.[mark]);
      return (runs) =>
        mergeRuns(
          runs.map((run) => {
            if (run.ref) return run;
            const marks = { ...(run.marks ?? {}) };
            if (remove) delete marks[mark];
            else marks[mark] = true;
            return Object.keys(marks).length > 0 ? { text: run.text, marks } : { text: run.text };
          })
        );
    });
  }

  /**
   * Link (or unlink, for "") every selected text unit.
   * @param {string} url
   * @returns {boolean}
   */
  function setLinkOnSelection(url) {
    return transformSelectedRuns("link", () => (runs) =>
      mergeRuns(
        runs.map((run) => {
          if (run.ref) return run;
          const marks = { ...(run.marks ?? {}) };
          if (url) marks.link = url;
          else delete marks.link;
          return Object.keys(marks).length > 0 ? { text: run.text, marks } : { text: run.text };
        })
      )
    );
  }

  return { deleteSelection, applyTypeToSelection, transformSelectedRuns, toggleMarkOnSelection, setLinkOnSelection };
}
