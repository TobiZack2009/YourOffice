/**
 * Structural keys for the document editor: Enter splits or leaves a block, Backspace
 * lifts, converts or merges, Tab nests or lifts. Each applies commands, re-renders and
 * puts the caret back. State shared with the editor arrives through the `ed` kernel.
 */

import { createId } from "../core/ids.js";
import { canIndentBlock, canIndentItem, canOutdentBlock, findContainer } from "../document/model.js";
import { selectionOffsets } from "./block-caret.js";
import { isBlankRuns, runLength, splitRunsAt } from "./block-runs.js";
import { caretOffset, mergeRuns, normalizeText, runsToPlainText } from "./inline.js";

const TEXTUAL_TYPES = new Set(["paragraph", "heading", "quote", "list", "code"]);

/** @typedef {import("../document/model.js").Block} Block */
/** @typedef {import("../document/model.js").InlineRun} InlineRun */

/** @param {any} ed Editor kernel (see `createDocumentEditor`). */
export function createBlockStructure(ed) {
  const { workspace, pageId, dispatch, render, content, blockOf, locateItem, parseKey, unitKey } = ed;
  const { focusKey, keyOfEditable, neighborKey, runsOf, insertTextInCode } = ed;

  /**
   * @param {Block} block
   * @returns {boolean}
   */
  function isTextual(block) {
    return TEXTUAL_TYPES.has(block.type);
  }

  /**
   * Plain text of a unit.
   * @param {string} key
   * @returns {InlineRun[]}
   */
  function runsOfUnit(key) {
    const { blockId, itemId } = parseKey(key);
    if (itemId) return locateItem(itemId)?.item.runs ?? [];
    const block = blockOf(blockId);
    if (!block) return [];
    if (block.type === "code") return block.text ? [{ text: block.text }] : [];
    return block.runs ?? [];
  }

  /**
   * @param {HTMLElement} el
   */
  function handleEnter(el) {
    const blockId = el.getAttribute("data-block-id") ?? "";
    const itemId = el.getAttribute("data-item-id");
    const block = blockOf(blockId);
    if (!block) return;

    if (block.type === "list" && itemId) {
      splitListItem(block, itemId, el);
      return;
    }

    if (block.type === "code") {
      const text = normalizeText(el.textContent ?? "");
      const { start, end } = selectionOffsets(el);
      if (start === end && start === text.length && text.endsWith("\n")) {
        // Enter on an empty last line leaves the code block.
        const newId = createId("block");
        workspace.transact("exit code block", () => {
          dispatch("updateBlock", { pageId, blockId, patch: { text: text.slice(0, -1) } });
          dispatch("insertBlock", {
            pageId,
            block: { type: "paragraph" },
            afterBlockId: blockId,
            newBlockId: newId
          });
        });
        render();
        focusKey(newId, "start");
        return;
      }
      insertTextInCode(el, "\n");
      return;
    }

    const runs = runsOf(el);
    const empty = isBlankRuns(runs);
    const nested = findContainer(content(), blockId)?.parent != null;

    // Enter on an empty nested block lifts it out of the list item.
    if (empty && nested) {
      dispatch("outdentBlock", { pageId, blockId });
      render();
      focusKey(blockId, "start");
      return;
    }

    // Enter on an empty quote ends it: the block becomes a plain paragraph.
    if (block.type === "quote" && empty) {
      dispatch("changeBlockType", { pageId, blockId, type: "paragraph" });
      render();
      focusKey(blockId, "start");
      return;
    }

    // Enter never duplicates the block kind: whatever follows is a new paragraph.
    const { left, right } = splitRunsAt(runs, caretOffset(el));
    const newId = createId("block");
    workspace.transact("split block", () => {
      dispatch("setBlockRuns", { pageId, blockId, runs: left });
      dispatch("insertBlock", {
        pageId,
        block: { type: "paragraph", runs: right },
        afterBlockId: blockId,
        newBlockId: newId
      });
    });
    render();
    focusKey(newId, "start");
  }

  /**
   * Split a list item at the caret, or lift it out of the list when empty.
   * @param {Block} block
   * @param {string} itemId
   * @param {HTMLElement} el
   */
  function splitListItem(block, itemId, el) {
    const items = block.items ?? [];
    const at = items.findIndex((item) => item.id === itemId);
    if (at === -1) return;
    const empty = isBlankRuns(runsOf(el));

    if (empty) {
      const parent = findContainer(content(), block.id)?.parent;
      if (parent) {
        // Nested: the item moves up one level and stays an item.
        dispatch("outdentListItem", { pageId, blockId: block.id, itemId });
        render();
        focusKey(unitKey(locateItem(itemId)?.block.id ?? parent.blockId, itemId), "start");
      } else {
        // Top level: the item ends the list and becomes a paragraph.
        const newId = createId("block");
        dispatch("outdentListItem", { pageId, blockId: block.id, itemId, newBlockId: newId });
        render();
        focusKey(newId, "start");
      }
      return;
    }

    const { left, right } = splitRunsAt(runsOf(el), caretOffset(el));
    const newItem = { id: createId("item"), runs: right };
    const nextItems = items.slice();
    nextItems[at] = { ...items[at], runs: left };
    nextItems.splice(at + 1, 0, newItem);
    dispatch("updateBlock", { pageId, blockId: block.id, patch: { items: nextItems } });
    render();
    focusKey(unitKey(block.id, newItem.id), "start");
  }

  /**
   * Backspace at the very start of a unit: lift, convert or merge.
   * @param {HTMLElement} el
   */
  function handleBackspace(el) {
    const blockId = el.getAttribute("data-block-id") ?? "";
    const itemId = el.getAttribute("data-item-id");
    const block = blockOf(blockId);
    if (!block) return;
    const key = keyOfEditable(el);
    const where = findContainer(content(), blockId);

    if (block.type === "list" && itemId) {
      const items = block.items ?? [];
      const at = items.findIndex((item) => item.id === itemId);
      if (at === -1) return;
      if (at === 0) {
        if (where?.parent) {
          dispatch("outdentListItem", { pageId, blockId, itemId });
          render();
          focusKey(unitKey(locateItem(itemId)?.block.id ?? blockId, itemId), "start");
        } else {
          const newId = createId("block");
          dispatch("outdentListItem", { pageId, blockId, itemId, newBlockId: newId });
          render();
          focusKey(newId, "start");
        }
        return;
      }
      const previous = items[at - 1];
      const current = items[at];
      const merged = mergeRuns([...(previous.runs ?? []), ...runsOf(el)]);
      const offset = runLength(previous.runs ?? []);
      const children = [...(previous.children ?? []), ...(current.children ?? [])];
      const nextItems = items.slice();
      nextItems[at - 1] = { ...previous, runs: merged, ...(children.length > 0 ? { children } : {}) };
      nextItems.splice(at, 1);
      dispatch("updateBlock", { pageId, blockId, patch: { items: nextItems } });
      render();
      focusKey(unitKey(blockId, previous.id), offset);
      return;
    }

    // First block nested in a list item: lift it out.
    if (where?.parent && where.index === 0) {
      dispatch("outdentBlock", { pageId, blockId });
      render();
      focusKey(blockId, "start");
      return;
    }

    const previousKey = neighborKey(key, -1, false);
    if (!previousKey) {
      // Start of the document: a styled block falls back to a plain paragraph.
      if (block.type !== "paragraph") {
        dispatch("changeBlockType", { pageId, blockId, type: "paragraph" });
        render();
        focusKey(blockId, "start");
      }
      return;
    }
    const target = parseKey(previousKey);
    const previous = blockOf(target.blockId);
    if (!previous || !isTextual(previous)) return;

    const appended = block.type === "code" ? runsOfUnit(blockId) : runsOf(el);
    const mergeOffset = runLength(runsOfUnit(previousKey));

    workspace.transact("merge blocks", () => {
      if (previous.type === "code") {
        dispatch("updateBlock", {
          pageId,
          blockId: previous.id,
          patch: { text: `${previous.text ?? ""}${runsToPlainText(appended)}` }
        });
      } else if (target.itemId) {
        const hit = locateItem(target.itemId);
        if (hit) {
          const items = (hit.block.items ?? []).map((item) =>
            item.id === target.itemId ? { ...item, runs: mergeRuns([...(item.runs ?? []), ...appended]) } : item
          );
          dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
        }
      } else {
        dispatch("setBlockRuns", {
          pageId,
          blockId: previous.id,
          runs: mergeRuns([...(previous.runs ?? []), ...appended])
        });
      }
      dispatch("deleteBlock", { pageId, blockId });
    });
    render();
    focusKey(previousKey, mergeOffset);
  }

  /**
   * Tab / Shift+Tab: nest or lift the unit under the caret.
   * @param {HTMLElement} el
   * @param {boolean} shift
   * @returns {boolean} Whether the key was consumed.
   */
  function handleTab(el, shift) {
    const blockId = el.getAttribute("data-block-id") ?? "";
    const itemId = el.getAttribute("data-item-id");
    const block = blockOf(blockId);
    if (!block) return false;

    if (block.type === "code") {
      if (shift) return false;
      insertTextInCode(el, "  ");
      return true;
    }

    const offset = caretOffset(el);
    if (itemId) {
      /** @type {string | null} */
      let newId = null;
      if (!shift) {
        if (canIndentItem(content(), blockId, itemId)) {
          dispatch("indentListItem", { pageId, blockId, itemId });
        }
      } else {
        // Nested items lift one level; a top-level item leaves the list as a paragraph.
        newId = createId("block");
        dispatch("outdentListItem", { pageId, blockId, itemId, newBlockId: newId });
      }
      render();
      const hit = locateItem(itemId);
      if (hit) focusKey(unitKey(hit.block.id, itemId), offset);
      else if (newId && blockOf(newId)) focusKey(newId, offset);
      return true;
    }

    if (!shift && canIndentBlock(content(), blockId)) {
      dispatch("indentBlock", { pageId, blockId });
    } else if (shift && canOutdentBlock(content(), blockId)) {
      dispatch("outdentBlock", { pageId, blockId });
    } else {
      // Nothing to nest under / lift out of: still swallow Tab so focus stays in the page.
      return true;
    }
    render();
    focusKey(blockId, offset);
    return true;
  }

  return { handleEnter, handleBackspace, handleTab };
}
