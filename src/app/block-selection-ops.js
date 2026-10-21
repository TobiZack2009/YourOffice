/**
 * Operations on the units picked by block selection: delete, change type, restyle runs.
 * State shared with the editor arrives through the `ed` kernel.
 */

import { createId } from "../core/ids.js";
import { splitRunsAt } from "./block-runs.js";
import { mergeRuns } from "./inline.js";

const RUN_TYPES = new Set(["paragraph", "heading", "quote"]);
const TEXTUAL_TYPES = new Set(["paragraph", "heading", "quote", "list", "code"]);

/** @typedef {import("../document/model.js").InlineRun} InlineRun */

/** @param {any} ed Editor kernel (see `createDocumentEditor`). */
export function createBlockSelectionOps(ed) {
  const { workspace, nested, pageId, dispatch, render, order, blockOf, locateItem, parseKey, unitKey, unitKeys, unitElement } = ed;
  const { editableOfUnit, focusKey, keyOfBlock, selectedKeys, setBlockSelection, notifyActiveChange } = ed;

  /** @param {string} key @returns {InlineRun[]} The text of a unit as runs (code text is one plain run). */
  function runsOfKey(key) {
    const { blockId, itemId } = parseKey(key);
    if (itemId) return locateItem(itemId)?.item.runs ?? [];
    const block = blockOf(blockId);
    if (block?.type === "code") return block.text ? [{ text: block.text }] : [];
    return block?.runs ?? [];
  }

  /**
   * Replace the text of one unit.
   * @param {string} key
   * @param {InlineRun[]} runs
   */
  function setRunsOfKey(key, runs) {
    const { blockId, itemId } = parseKey(key);
    if (itemId) {
      const hit = locateItem(itemId);
      if (!hit) return;
      const items = (hit.block.items ?? []).map((item) => (item.id === itemId ? { ...item, runs } : item));
      dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
    } else if (blockOf(blockId)?.type === "code") {
      dispatch("updateBlock", { pageId, blockId, patch: { text: runs.map((run) => run.text).join("") } });
    } else {
      dispatch("setBlockRuns", { pageId, blockId, runs });
    }
  }

  /**
   * Delete what the selection covers as one undoable step: whole units go, and the two end
   * units are trimmed (and joined when both are partial text).
   * @returns {{ key: string, offset: number } | null} Where the caret belongs afterwards, if text remains there.
   */
  function deleteSelection() {
    const covered = ed.unitSelection.spans();
    if (covered.length === 0) return null;
    const first = covered[0];
    const last = covered[covered.length - 1];
    const all = unitKeys();
    const before = all.slice(0, all.indexOf(first.key)).reverse();
    const after = all.slice(all.indexOf(last.key) + 1);
    const fallbackId = createId("block");
    const single = covered.length === 1;
    const join = !single && !first.whole && !last.whole && ![first, last].some((span) => blockOf(parseKey(span.key).blockId)?.type === "code");
    const doomed = covered.filter((span) => span.whole).map((span) => span.key);
    if (join) doomed.push(last.key);
    /** @type {{ key: string, offset: number } | null} */
    let caret = null;

    workspace.transact("delete selection", () => {
      if (single && !first.whole) {
        const runs = runsOfKey(first.key);
        const left = splitRunsAt(runs, first.start).left;
        const right = splitRunsAt(runs, first.end).right;
        setRunsOfKey(first.key, mergeRuns([...left, ...right]));
        caret = { key: first.key, offset: first.start };
        return;
      }
      if (join) {
        const left = splitRunsAt(runsOfKey(first.key), first.start).left;
        const right = splitRunsAt(runsOfKey(last.key), last.end).right;
        setRunsOfKey(first.key, mergeRuns([...left, ...right]));
        caret = { key: first.key, offset: first.start };
      } else {
        if (!first.whole) {
          setRunsOfKey(first.key, splitRunsAt(runsOfKey(first.key), first.start).left);
          caret = { key: first.key, offset: first.start };
        }
        if (!last.whole) {
          setRunsOfKey(last.key, splitRunsAt(runsOfKey(last.key), last.end).right);
          caret ??= { key: last.key, offset: 0 };
        }
      }
      const keys = doomed;
      if (nested) {
        // An embed must keep a block to type in: add one after the run before it empties.
        const gone = new Set(keys.filter((key) => !parseKey(key).itemId).map((key) => parseKey(key).blockId));
        const run = order();
        if (run.length > 0 && run.every((id) => gone.has(id))) {
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
    if (caret && focusKey(caret.key, caret.offset)) return caret;
    const target = [...before, ...after].find((key) => editableOfUnit(unitElement(key)));
    if (!(target && focusKey(target, before.includes(target) ? "end" : "start"))) {
      const first = unitKeys().find((key) => editableOfUnit(unitElement(key)));
      if (first) focusKey(first, "start");
    }
    return null;
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
    const targets = ed.unitSelection
      .spans()
      .map((span) => {
        const { blockId, itemId } = parseKey(span.key);
        const block = blockOf(blockId);
        if (!block) return null;
        if (itemId) {
          const hit = locateItem(itemId);
          return hit ? { blockId: hit.block.id, itemId, runs: hit.item.runs ?? [], span } : null;
        }
        return RUN_TYPES.has(block.type) ? { blockId, itemId: null, runs: block.runs ?? [], span } : null;
      })
      .filter((target) => target !== null);
    /** The part of a unit's runs the selection covers, split from what it leaves. */
    const parts = (/** @type {InlineRun[]} */ runs, /** @type {{ start: number, end: number, whole: boolean }} */ span) => {
      if (span.whole) return { head: [], body: runs, tail: [] };
      const { left: head, right } = splitRunsAt(runs, span.start);
      const { left: body, right: tail } = splitRunsAt(right, span.end - span.start);
      return { head, body, tail };
    };
    const allRuns = targets.flatMap((target) => parts(target.runs, target.span).body);
    if (allRuns.length === 0) return false;
    const restyle = plan(allRuns);
    const rewrite = (/** @type {InlineRun[]} */ runs, /** @type {typeof targets[number]["span"]} */ span) => {
      const { head, body, tail } = parts(runs, span);
      return mergeRuns([...head, ...restyle(body), ...tail]);
    };

    workspace.transact(label, () => {
      for (const target of targets) {
        if (target.itemId) {
          const hit = locateItem(target.itemId);
          if (!hit) continue;
          const items = (hit.block.items ?? []).map((item) =>
            item.id === target.itemId ? { ...item, runs: rewrite(item.runs ?? [], target.span) } : item
          );
          dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
        } else {
          const block = blockOf(target.blockId);
          if (block) {
            dispatch("setBlockRuns", {
              pageId,
              blockId: target.blockId,
              runs: rewrite(block.runs ?? [], target.span)
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
