/**
 * Copy, cut and paste for the document editor.
 *
 * Block selection clears the browser's own selection, so the browser has nothing to copy: this
 * controller answers the clipboard events itself. A copy carries three formats: plain text,
 * HTML, and a private JSON fragment that a paste inside the app turns back into real blocks
 * (new ids, marks kept). A paste of anything else is read as plain text. Cut is copy plus the
 * same range delete as the Delete key, and a paste over a selection replaces it, each as one
 * undoable step. State shared with the editor arrives through the `ed` kernel.
 */

import { renderBlock } from "../document/render.js";
import { editableFrom, selectionOffsets } from "./block-caret.js";
import {
  FRAGMENT_MIME,
  inlineRunsOf,
  planFragment,
  readFragment,
  sliceUnits,
  fragmentText,
  textToFragment
} from "./block-fragment.js";
import { isBlankRuns, runLength, splitRunsAt } from "./block-runs.js";
import { mergeRuns } from "./inline.js";

const RUN_TYPES = new Set(["paragraph", "heading", "quote"]);

/** @typedef {import("./block-fragment.js").Fragment} Fragment */
/** @typedef {import("../document/model.js").InlineRun} InlineRun */

/**
 * @param {any} ed Editor kernel (see `createDocumentEditor`).
 * @param {{ selectionOps: ReturnType<typeof import("./block-selection-ops.js").createBlockSelectionOps> }} parts
 */
export function createBlockClipboard(ed, parts) {
  const { selectionOps } = parts;
  const { element, owns, workspace, pageId, dispatch, render, content, order, blockOf, locateItem, parseKey, unitKey, focusKey } = ed;

  /** @type {{ text: string, fragment: Fragment } | null} The last copy, so a menu paste (plain text only) can restore structure. */
  let lastCopy = null;

  /** @returns {Fragment | null} The blocks the current block selection covers. */
  function selectedFragment() {
    if (!ed.sel()) return null;
    const units = ed.unitSelection.spans().map((span) => {
      const { blockId, itemId } = parseKey(span.key);
      return { blockId, itemId, start: span.start, end: span.whole ? null : span.end };
    });
    const fragment = sliceUnits(content(), units);
    return fragment.blocks.length > 0 ? fragment : null;
  }

  /**
   * HTML for a fragment, without the editor's bookkeeping attributes.
   * @param {Fragment} fragment
   * @returns {string}
   */
  function fragmentHtml(fragment) {
    const doc = element.ownerDocument;
    const root = doc.createElement("div");
    for (const block of fragment.blocks) {
      const drawn = renderBlock(/** @type {any} */ (block), {
        document: doc,
        blocks: fragment.descendants,
        resolvePageTitle: ed.options.resolvePageTitle
      });
      if (drawn) root.append(drawn);
    }
    for (const el of root.querySelectorAll("*")) {
      for (const name of el.getAttributeNames()) {
        if (name.startsWith("data-") || name === "contenteditable" || name === "class") el.removeAttribute(name);
      }
    }
    return root.innerHTML;
  }

  /**
   * @param {DataTransfer} data
   * @param {Fragment} fragment
   */
  function write(data, fragment) {
    const text = fragmentText(fragment, { pageTitle: ed.options.resolvePageTitle });
    data.setData("text/plain", text);
    data.setData("text/html", fragmentHtml(fragment));
    data.setData(FRAGMENT_MIME, JSON.stringify(fragment));
    lastCopy = { text, fragment };
  }

  /** @param {Event} event */
  function onCopy(event) {
    const data = /** @type {ClipboardEvent} */ (event).clipboardData;
    const fragment = selectedFragment();
    if (!data || !fragment || !owns(/** @type {Node} */ (event.target))) return;
    event.preventDefault();
    write(data, fragment);
  }

  /** @param {Event} event */
  function onCut(event) {
    const data = /** @type {ClipboardEvent} */ (event).clipboardData;
    const fragment = selectedFragment();
    if (!data || !fragment || !owns(/** @type {Node} */ (event.target))) return;
    event.preventDefault();
    write(data, fragment);
    selectionOps.deleteSelection();
  }

  /** @param {Event} event */
  function onPaste(event) {
    if (event.defaultPrevented || !owns(/** @type {Node} */ (event.target))) return;
    const data = /** @type {ClipboardEvent} */ (event).clipboardData;
    if (!data) return;
    const el = editableFrom(/** @type {Node} */ (event.target));
    if (el?.matches("code[data-block-id]")) return;
    const fragment = readFragment(data.getData(FRAGMENT_MIME)) ?? textFragment(data.getData("text/plain"));
    if (!fragment) return;
    event.preventDefault();
    paste(fragment);
  }

  /** @param {string} text @returns {Fragment | null} */
  function textFragment(text) {
    const fragment = textToFragment(text ?? "");
    return fragment.blocks.length > 0 ? fragment : null;
  }

  /**
   * Plain text from the system clipboard (the context menu cannot read the private format);
   * the last copy made here is used instead when the text still matches it.
   * @param {string} text
   */
  function pasteText(text) {
    const fragment = lastCopy && lastCopy.text === text ? lastCopy.fragment : textFragment(text);
    if (fragment) paste(fragment);
  }

  /** Copy the block selection through the system clipboard (the context-menu path). */
  function copySelection() {
    const doc = element.ownerDocument;
    if (typeof doc.execCommand === "function") doc.execCommand("copy");
  }

  /** Cut the block selection through the system clipboard (the context-menu path). */
  function cutSelection() {
    const doc = element.ownerDocument;
    if (typeof doc.execCommand === "function") doc.execCommand("cut");
  }

  // -- paste ---------------------------------------------------------------------

  /** @param {string} key @returns {InlineRun[]} */
  function runsOfKey(key) {
    const { blockId, itemId } = parseKey(key);
    if (itemId) return locateItem(itemId)?.item.runs ?? [];
    return blockOf(blockId)?.runs ?? [];
  }

  /** @param {string} key @param {InlineRun[]} runs */
  function setRunsOfKey(key, runs) {
    const { blockId, itemId } = parseKey(key);
    if (itemId) {
      const hit = locateItem(itemId);
      if (!hit) return;
      const items = (hit.block.items ?? []).map((/** @type {any} */ item) => (item.id === itemId ? { ...item, runs } : item));
      dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
    } else {
      dispatch("setBlockRuns", { pageId, blockId, runs });
    }
  }

  /**
   * Where a paste lands: the unit holding the caret, with its text split around the selection.
   * @returns {{ key: string, left: InlineRun[], right: InlineRun[] } | null}
   */
  function caretContext() {
    const blockId = ed.activeBlockId();
    if (!blockId || !blockOf(blockId) || blockOf(blockId).type === "code") return null;
    const key = unitKey(blockId, ed.activeItemId());
    const el = ed.findEditable(blockId, ed.activeItemId());
    if (!el) return null;
    const { start, end } = selectionOffsets(el);
    const runs = runsOfKey(key);
    return {
      key,
      left: splitRunsAt(runs, Math.min(start, end)).left,
      right: splitRunsAt(runs, Math.max(start, end)).right
    };
  }

  /**
   * Put a fragment into the document at the caret, replacing the selection.
   * @param {Fragment} fragment
   */
  function paste(fragment) {
    /** @type {{ key: string, offset: number } | { blockId: string } | null} */
    let caret = null;

    workspace.transact("paste", () => {
      const covered = ed.sel() ? ed.unitSelection.spans() : [];
      if (covered.length > 0 && covered.every((/** @type {any} */ span) => span.whole)) {
        // Whole units: the new blocks go after the last one, then the selection is removed.
        caret = insertAfterBlock(parseKey(covered[covered.length - 1].key).blockId, fragment);
        selectionOps.deleteSelection();
        return;
      }
      if (covered.length > 0) {
        // Partial ends: trim them, then paste where the removed text was.
        const landed = selectionOps.deleteSelection();
        if (landed) {
          const runs = runsOfKey(landed.key);
          caret = insertAt(
            { key: landed.key, left: splitRunsAt(runs, landed.offset).left, right: splitRunsAt(runs, landed.offset).right },
            fragment
          );
          return;
        }
      }
      const context = covered.length > 0 ? null : caretContext();
      caret = context ? insertAt(context, fragment) : insertAfterBlock(order().at(-1) ?? null, fragment);
    });

    render();
    const landed = /** @type {{ key: string, offset: number } | { blockId: string } | null} */ (caret);
    if (landed && "key" in landed) focusKey(landed.key, landed.offset);
    else if (landed && "blockId" in landed) focusKey(unitKeyOfBlock(landed.blockId), "end");
  }

  /** @param {string} blockId @returns {string} */
  function unitKeyOfBlock(blockId) {
    const block = blockOf(blockId);
    return block?.type === "list" ? unitKey(blockId, block.items?.at(-1)?.id ?? null) : blockId;
  }

  /**
   * Insert blocks after a block (or at the end), returning where the caret goes.
   * @param {string | null} afterBlockId
   * @param {Fragment} fragment
   * @returns {{ blockId: string } | null}
   */
  function insertAfterBlock(afterBlockId, fragment) {
    const plan = planFragment(fragment);
    let previous = afterBlockId;
    let last = null;
    for (const step of plan) {
      dispatch("insertBlock", {
        pageId,
        block: step.spec,
        newBlockId: step.blockId,
        ...(step.parent ? { parent: step.parent } : previous ? { afterBlockId: previous } : {})
      });
      if (!step.parent) {
        previous = step.blockId;
        last = step.blockId;
      }
    }
    return last ? { blockId: last } : null;
  }

  /**
   * Insert a fragment at a caret inside a text unit.
   * @param {{ key: string, left: InlineRun[], right: InlineRun[] }} context
   * @param {Fragment} fragment
   * @returns {{ key: string, offset: number } | { blockId: string } | null}
   */
  function insertAt(context, fragment) {
    const { key, left, right } = context;
    const { blockId, itemId } = parseKey(key);
    const inline = inlineRunsOf(fragment);
    if (inline) {
      setRunsOfKey(key, mergeRuns([...left, ...inline, ...right]));
      return { key, offset: runLength(left) + runLength(inline) };
    }

    const block = blockOf(blockId);
    const plan = planFragment(fragment);
    const empty = isBlankRuns(left) && isBlankRuns(right);

    // An empty plain paragraph is replaced by what is pasted.
    if (empty && !itemId && block?.type === "paragraph") {
      const landed = insertAfterBlock(blockId, fragment);
      dispatch("deleteBlock", { pageId, blockId });
      return landed;
    }

    // The first pasted paragraph joins the text before the caret; the text after the caret
    // follows the last pasted paragraph.
    const top = plan.filter((step) => !step.parent);
    const first = top[0];
    let head = left;
    let rest = top;
    if (first && RUN_TYPES.has(first.spec.type)) {
      head = [...left, ...(first.spec.runs ?? [])];
      rest = top.slice(1);
    }
    /** @type {{ key: string, offset: number } | { blockId: string } | null} */
    let caret;
    if (rest.length === 0) {
      setRunsOfKey(key, mergeRuns([...head, ...right]));
      return { key, offset: runLength(head) };
    }
    let tail = right;
    const last = rest[rest.length - 1];
    if (!itemId && !isBlankRuns(tail) && RUN_TYPES.has(last.spec.type)) {
      last.spec.runs = mergeRuns([...(last.spec.runs ?? []), ...tail]);
      caret = { key: last.blockId, offset: runLength(last.spec.runs) - runLength(tail) };
      tail = [];
    } else if (itemId) {
      head = mergeRuns([...head, ...tail]);
      tail = [];
    }
    setRunsOfKey(key, mergeRuns(head));

    // Rest go after the unit's block (children follow their parents in the plan).
    const inserted = new Set(rest.map((step) => step.blockId));
    let previous = blockId;
    for (const step of plan) {
      const isTop = !step.parent;
      if (isTop ? !inserted.has(step.blockId) : !inserted.has(step.parent?.blockId ?? "")) continue;
      if (!isTop) inserted.add(step.blockId);
      dispatch("insertBlock", {
        pageId,
        block: step.spec,
        newBlockId: step.blockId,
        ...(step.parent ? { parent: step.parent } : { afterBlockId: previous })
      });
      if (isTop) previous = step.blockId;
    }
    if (!isBlankRuns(tail)) {
      dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: tail }, afterBlockId: previous });
    }
    return caret ?? { blockId: previous };
  }

  /** Listen on the editor's element. */
  function attach() {
    element.addEventListener("copy", onCopy);
    element.addEventListener("cut", onCut);
    element.addEventListener("paste", onPaste);
  }

  return { attach, copySelection, cutSelection, pasteText, paste };
}
