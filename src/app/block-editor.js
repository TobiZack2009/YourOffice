/**
 * Document block editor.
 *
 * Each run-capable block is its own contenteditable element, so the browser only
 * ever edits inline content inside one block; all structure (new blocks, splits,
 * merges, deletes) is applied by dispatching commands and re-rendering from the
 * model. That keeps the DOM a rendering surface, never the source of truth.
 *
 * Inline typing is committed on `input` via `setBlockRuns`/`updateBlock`. Because
 * the DOM already matches the model after those commits, the store `change`
 * handler skips re-rendering for inline-only commits — this is what preserves the
 * caret while typing.
 */

import { createId } from "../core/ids.js";
import {
  canIndentBlock,
  canIndentItem,
  canOutdentBlock,
  ensureDocumentContent,
  findContainer
} from "../document/model.js";
import { renderBlock, renderRuns } from "../document/render.js";
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { buildMenu, createPopoverHost } from "./popover.js";
import { mergeRuns, normalizeText, parseInlineRuns, runsEqual, runsToPlainText } from "./inline.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../document/model.js").Block} Block */
/** @typedef {import("../document/model.js").InlineRun} InlineRun */

const RUN_TYPES = new Set(["paragraph", "heading", "quote"]);
const TEXTUAL_TYPES = new Set(["paragraph", "heading", "quote", "list", "code"]);
const INLINE_COMMITS = new Set(["setBlockRuns", "updateBlock"]);

const MARK_TAG = { bold: "strong", italic: "em", underline: "u", strike: "s", code: "code" };
const EXEC_COMMAND = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };

/**
 * Split runs at a plain-text offset, keeping marks on both halves.
 * @param {InlineRun[]} runs
 * @param {number} offset
 * @returns {{ left: InlineRun[], right: InlineRun[] }}
 */
export function splitRunsAt(runs, offset) {
  /** @type {InlineRun[]} */
  const left = [];
  /** @type {InlineRun[]} */
  const right = [];
  let consumed = 0;
  for (const run of runs) {
    const end = consumed + run.text.length;
    if (end <= offset) {
      left.push(run);
    } else if (consumed >= offset) {
      right.push(run);
    } else {
      const local = offset - consumed;
      const before = run.text.slice(0, local);
      const after = run.text.slice(local);
      if (before) left.push(run.marks ? { text: before, marks: { ...run.marks } } : { text: before });
      if (after) right.push(run.marks ? { text: after, marks: { ...run.marks } } : { text: after });
    }
    consumed = end;
  }
  return { left: mergeRuns(left), right: mergeRuns(right) };
}

/**
 * Split a string at an offset.
 * @param {string} text
 * @param {number} offset
 * @returns {{ left: string, right: string }}
 */
function splitTextAt(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  return { left: text.slice(0, clamped), right: text.slice(clamped) };
}

/**
 * @param {Element} element
 * @returns {boolean}
 */
function isEditable(element) {
  return element.getAttribute("contenteditable") === "true";
}

/**
 * @param {Node | null} node
 * @returns {HTMLElement | null}
 */
function editableFrom(node) {
  let current = node instanceof Element ? node : node?.parentElement ?? null;
  while (current) {
    if (isEditable(current)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * @param {Node | null} node
 * @returns {boolean}
 */
function isRangeInside(editor) {
  const doc = editor.ownerDocument;
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return false;
  const node = selection.getRangeAt(0).startContainer;
  return editor.contains(node);
}

/**
 * @param {Element} element
 * @returns {number} Caret offset in characters from the element start.
 */
function caretOffset(element) {
  const doc = element.ownerDocument;
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return (element.textContent ?? "").length;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return (element.textContent ?? "").length;
  const probe = doc.createRange();
  probe.selectNodeContents(element);
  try {
    probe.setEnd(range.startContainer, range.startOffset);
  } catch {
    return (element.textContent ?? "").length;
  }
  return probe.toString().length;
}

/**
 * Start and end of the current selection as character offsets in an element.
 * @param {Element} element
 * @returns {{ start: number, end: number }}
 */
function selectionOffsets(element) {
  const doc = element.ownerDocument;
  const length = (element.textContent ?? "").length;
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return { start: length, end: length };
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return { start: length, end: length };
  }
  const measure = (container, offset) => {
    const probe = doc.createRange();
    probe.selectNodeContents(element);
    try {
      probe.setEnd(container, offset);
    } catch {
      return length;
    }
    return probe.toString().length;
  };
  return {
    start: measure(range.startContainer, range.startOffset),
    end: measure(range.endContainer, range.endOffset)
  };
}

/**
 * Place the caret at an offset within an element.
 * @param {HTMLElement} element
 * @param {"start" | "end" | number} where
 */
function placeCaret(element, where = "end") {
  if (!element) return;
  const doc = element.ownerDocument;
  element.focus();
  const selection = doc.getSelection?.();
  if (!selection) return;
  const range = doc.createRange();

  if (where === "end") {
    range.selectNodeContents(element);
    range.collapse(false);
  } else if (where === "start") {
    range.setStart(element, 0);
    range.collapse(true);
  } else {
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = where;
    let node = walker.nextNode();
    while (node) {
      const length = (node.textContent ?? "").length;
      if (remaining <= length) {
        range.setStart(node, remaining);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= length;
      node = walker.nextNode();
    }
    range.selectNodeContents(element);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Create a document editor bound to one page.
 *
 * @param {Workspace} workspace
 * @param {string} pageId
 * @param {{ resolvePageTitle?: (id: string) => string | undefined, onActiveChange?: (info: ActiveInfo) => void, onChange?: () => void }} [options]
 * @returns {EditorHandle}
 */
export function createDocumentEditor(workspace, pageId, options = {}) {
  const element = h("div", {
    class: "document-editor",
    role: "group",
    "aria-label": "Document body",
    tabindex: "-1"
  });
  /** @type {string | null} */
  let activeBlockId = null;
  /** @type {string | null} */
  let activeItemId = null;

  const renderOptions = {
    resolvePageTitle: options.resolvePageTitle
  };

  /** @returns {import("../document/model.js").DocumentContent} */
  function content() {
    const page = workspace.getPage(pageId);
    return page
      ? ensureDocumentContent(page)
      : { blockOrder: [], blocks: {} };
  }

  /** @param {string} blockId @returns {Block | undefined} */
  function blockOf(blockId) {
    return content().blocks[blockId];
  }

  /** @returns {string[]} */
  function order() {
    return content().blockOrder;
  }

  /**
   * Find a list item (and its list) anywhere in the document.
   * @param {string} itemId
   * @returns {{ block: Block, index: number, item: NonNullable<Block["items"]>[number] } | null}
   */
  function locateItem(itemId) {
    for (const block of Object.values(content().blocks)) {
      if (block.type !== "list") continue;
      const index = (block.items ?? []).findIndex((item) => item.id === itemId);
      if (index !== -1) return { block, index, item: /** @type {any} */ (block.items)[index] };
    }
    return null;
  }

  // -- selection units ---------------------------------------------------------
  // A "unit" is the smallest thing block selection works on: a block, or one list
  // item. Its key is `blockId` or `blockId:itemId`, stored in `data-unit`.

  /**
   * @param {string} blockId
   * @param {string | null} [itemId]
   * @returns {string}
   */
  function unitKey(blockId, itemId = null) {
    return itemId ? `${blockId}:${itemId}` : blockId;
  }

  /** @param {string} key @returns {{ blockId: string, itemId: string | null }} */
  function parseKey(key) {
    const at = key.indexOf(":");
    return at === -1
      ? { blockId: key, itemId: null }
      : { blockId: key.slice(0, at), itemId: key.slice(at + 1) };
  }

  /** @returns {string[]} Unit keys in reading (DOM) order. */
  function unitKeys() {
    return [...element.querySelectorAll("[data-unit]")].map((el) => el.getAttribute("data-unit") ?? "");
  }

  /** @param {string} key @returns {HTMLElement | null} */
  function unitElement(key) {
    return /** @type {HTMLElement | null} */ (element.querySelector(`[data-unit="${key}"]`));
  }

  /** @param {HTMLElement | null} unit @returns {HTMLElement | null} */
  function editableOfUnit(unit) {
    if (!unit) return null;
    if (isEditable(unit)) return unit;
    return /** @type {HTMLElement | null} */ (unit.querySelector('[contenteditable="true"]'));
  }

  /** @param {Element} el @returns {string} */
  function keyOfEditable(el) {
    return unitKey(el.getAttribute("data-block-id") ?? "", el.getAttribute("data-item-id"));
  }

  /**
   * Nearest unit before/after a key in reading order.
   * @param {string} key
   * @param {-1 | 1} direction
   * @param {boolean} textualOnly Skip units that cannot hold a caret.
   * @returns {string | null}
   */
  function neighborKey(key, direction, textualOnly) {
    const keys = unitKeys();
    for (let i = keys.indexOf(key) + direction; i >= 0 && i < keys.length; i += direction) {
      if (!textualOnly || editableOfUnit(unitElement(keys[i]))) return keys[i];
    }
    return null;
  }

  /** @param {string} blockId @returns {string} The unit key a caret should land in. */
  function keyOfBlock(blockId) {
    const block = blockOf(blockId);
    if (block?.type === "list") return unitKey(blockId, block.items?.[0]?.id ?? null);
    return blockId;
  }

  // -- rendering ---------------------------------------------------------------

  /**
   * @param {Block} block
   * @returns {HTMLElement | null}
   */
  function renderEditable(block) {
    if (block.type === "paragraph" || block.type === "quote") {
      const element_ = document.createElement(block.type === "quote" ? "blockquote" : "p");
      decorateEditable(element_, block, "Write…");
      element_.append(renderRuns(block.runs ?? [], renderOptions));
      return element_;
    }
    if (block.type === "heading") {
      const level = Math.min(3, Math.max(1, block.level ?? 1));
      const element_ = document.createElement(`h${level}`);
      decorateEditable(element_, block, "Heading");
      element_.append(renderRuns(block.runs ?? [], renderOptions));
      return element_;
    }
    if (block.type === "list") {
      const element_ = document.createElement(block.ordered ? "ol" : "ul");
      element_.className = "block block-list";
      element_.setAttribute("data-block-id", block.id);
      element_.setAttribute("data-block-type", "list");
      for (const item of block.items ?? []) {
        const li = document.createElement("li");
        const row = document.createElement("div");
        row.className = "block-item";
        row.setAttribute("contenteditable", "true");
        row.setAttribute("data-block-id", block.id);
        row.setAttribute("data-item-id", item.id);
        row.setAttribute("data-unit", unitKey(block.id, item.id));
        if ((item.runs ?? []).length === 0) row.setAttribute("data-placeholder", "List item");
        row.append(renderRuns(item.runs ?? [], renderOptions));
        li.append(row);
        if (item.children && item.children.length > 0) {
          const nested = document.createElement("div");
          nested.className = "item-children";
          for (const childId of item.children) {
            const child = blockOf(childId);
            const rendered = child ? renderEditable(child) : null;
            if (rendered) nested.append(rendered);
          }
          li.append(nested);
        }
        element_.append(li);
      }
      return element_;
    }
    if (block.type === "code") {
      const pre = document.createElement("pre");
      pre.className = "block block-code";
      pre.setAttribute("data-block-id", block.id);
      pre.setAttribute("data-block-type", "code");
      pre.setAttribute("data-unit", block.id);
      const code = document.createElement("code");
      code.setAttribute("contenteditable", "true");
      code.setAttribute("spellcheck", "false");
      code.setAttribute("data-block-id", block.id);
      code.setAttribute("data-placeholder", "Code");
      code.textContent = block.text ?? "";
      pre.append(code);
      // Clicking the padding around the code should still land the caret in it.
      pre.addEventListener("mousedown", (event) => {
        if (event.target === pre) {
          event.preventDefault();
          placeCaret(code, "end");
        }
      });
      return pre;
    }
    const rendered = renderBlock(block, renderOptions);
    if (!rendered) return null;
    rendered.classList.add("block");
    rendered.setAttribute("data-unit", block.id);
    return rendered;
  }

  /**
   * @param {HTMLElement} element_
   * @param {Block} block
   * @param {string} placeholder
   */
  function decorateEditable(element_, block, placeholder) {
    element_.className = `block block-editable block-${block.type}`;
    element_.setAttribute("contenteditable", "true");
    element_.setAttribute("data-block-id", block.id);
    element_.setAttribute("data-block-type", block.type);
    element_.setAttribute("data-unit", block.id);
    if (((block.runs ?? []).length === 0)) element_.setAttribute("data-placeholder", placeholder);
  }

  function render() {
    clear(element);
    const c = content();
    const blocks = c.blockOrder.map((id) => c.blocks[id]).filter(Boolean);
    if (blocks.length === 0) {
      const start = h("div", { class: "empty-document", text: "Start writing…" });
      start.addEventListener("mousedown", (event) => {
        event.preventDefault();
        insertAtEnd({ type: "paragraph" });
      });
      element.append(start);
      applySelection();
      return;
    }
    for (const block of blocks) {
      const el = renderEditable(block);
      if (el) element.append(el);
    }
    applySelection();
  }

  // -- element lookup ----------------------------------------------------------

  /** @param {string | null} blockId @param {string | null} [itemId] @returns {HTMLElement | null} */
  function findEditable(blockId, itemId = null) {
    if (itemId) {
      return /** @type {HTMLElement | null} */ (
        element.querySelector(`[contenteditable="true"][data-item-id="${itemId}"]`)
      );
    }
    if (!blockId) return null;
    const matches = element.querySelectorAll(
      `[contenteditable="true"][data-block-id="${blockId}"]:not([data-item-id])`
    );
    return /** @type {HTMLElement | null} */ (matches[0] ?? null);
  }

  /** @returns {HTMLElement | null} */
  function activeEditable() {
    return findEditable(activeBlockId, activeItemId);
  }

  // -- inline commits ----------------------------------------------------------

  /**
   * Push the DOM contents of an editable element back into the model.
   * @param {HTMLElement} el
   */
  function commitEditable(el) {
    const blockId = el.getAttribute("data-block-id");
    const itemId = el.getAttribute("data-item-id");
    const block = blockId ? blockOf(blockId) : undefined;
    if (!block) return;

    if (block.type === "code") {
      const text = normalizeText(el.textContent ?? "");
      if (text !== (block.text ?? "")) {
        workspace.dispatch("updateBlock", { pageId, blockId, patch: { text } });
      }
      return;
    }

    const runs = parseInlineRuns(el);
    if (block.type === "list" && itemId) {
      const hit = locateItem(itemId);
      if (hit && !runsEqual(hit.item.runs ?? [], runs)) {
        const items = (hit.block.items ?? []).map((item) => (item.id === itemId ? { ...item, runs } : item));
        workspace.dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
      }
      return;
    }

    if (!runsEqual(block.runs ?? [], runs)) {
      workspace.dispatch("setBlockRuns", { pageId, blockId, runs });
    }
  }

  /**
   * @param {Element} el
   * @returns {InlineRun[]}
   */
  function runsOf(el) {
    return parseInlineRuns(el);
  }

  // -- focus helpers -----------------------------------------------------------

  /**
   * @param {string | null} blockId
   * @param {string | null} itemId
   */
  function setActive(blockId, itemId) {
    activeBlockId = blockId;
    activeItemId = itemId;
    notifyActiveChange();
  }

  /**
   * Put the caret in a unit, leaving block-selection mode.
   * @param {string} key
   * @param {"start" | "end" | number} [where]
   * @returns {boolean}
   */
  function focusKey(key, where = "end") {
    const el = editableOfUnit(unitElement(key));
    if (!el) return false;
    if (sel) {
      sel = null;
      applySelection();
    }
    placeCaret(el, where);
    setActive(el.getAttribute("data-block-id"), el.getAttribute("data-item-id"));
    return true;
  }

  /**
   * @param {string} blockId
   * @param {"start" | "end" | number} [where]
   */
  function focusBlock(blockId, where = "end") {
    if (!blockOf(blockId)) return;
    focusKey(keyOfBlock(blockId), where);
  }

  // -- block (multi-unit) selection -------------------------------------------

  /** @type {{ anchor: string, focus: string } | null} */
  let sel = null;
  /** @type {string | null} Unit where the current mouse drag began. */
  let dragAnchor = null;

  /** @returns {string[]} Selected unit keys, in reading order. */
  function selectedKeys() {
    if (!sel) return [];
    const keys = unitKeys();
    const a = keys.indexOf(sel.anchor);
    const f = keys.indexOf(sel.focus);
    if (a === -1 || f === -1) return [];
    return keys.slice(Math.min(a, f), Math.max(a, f) + 1);
  }

  function applySelection() {
    for (const el of element.querySelectorAll(".is-block-selected")) {
      el.classList.remove("is-block-selected");
    }
    const keys = selectedKeys();
    if (keys.length === 0) sel = null;
    element.classList.toggle("is-block-selecting", sel !== null);
    for (const key of keys) unitElement(key)?.classList.add("is-block-selected");
  }

  /**
   * Enter block-selection mode over the units between two keys.
   * @param {string} anchor
   * @param {string} focus
   */
  function setBlockSelection(anchor, focus) {
    sel = { anchor, focus };
    const doc = element.ownerDocument;
    doc.getSelection?.()?.removeAllRanges();
    const current = doc.activeElement;
    if (current && current !== element && element.contains(current)) /** @type {HTMLElement} */ (current).blur();
    element.focus({ preventScroll: true });
    applySelection();
    const { blockId, itemId } = parseKey(focus);
    setActive(blockId, itemId);
  }

  function clearBlockSelection() {
    if (!sel) return;
    sel = null;
    applySelection();
    notifyActiveChange();
  }

  function selectAllUnits() {
    const keys = unitKeys();
    if (keys.length > 0) setBlockSelection(keys[0], keys[keys.length - 1]);
  }

  /** Delete every selected unit as one undoable step. */
  function deleteSelection() {
    const keys = selectedKeys();
    if (keys.length === 0) return;
    const all = unitKeys();
    const before = all.slice(0, all.indexOf(keys[0])).reverse();
    const after = all.slice(all.indexOf(keys[keys.length - 1]) + 1);
    const fallbackId = createId("block");

    workspace.transact("delete selection", () => {
      // Reverse reading order removes nested units before the units that hold them.
      for (const key of [...keys].reverse()) {
        const { blockId, itemId } = parseKey(key);
        const block = blockOf(blockId);
        if (!block) continue;
        if (itemId) {
          if ((block.items ?? []).some((item) => item.id === itemId)) {
            workspace.dispatch("deleteListItem", { pageId, blockId, itemId });
          }
        } else {
          workspace.dispatch("deleteBlock", { pageId, blockId });
        }
      }
      if (order().length === 0) {
        workspace.dispatch("insertBlock", {
          pageId,
          block: { type: "paragraph" },
          newBlockId: fallbackId
        });
      }
    });

    sel = null;
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
              workspace.dispatch("updateBlock", {
                pageId,
                blockId: hit.block.id,
                patch: { ordered: spec.ordered }
              });
            }
            resulting.push(unitKey(hit.block.id, itemId));
          } else {
            const newBlockId = createId("block");
            workspace.dispatch("extractListItem", {
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
        workspace.dispatch("changeBlockType", { pageId, blockId, type: spec.type, fields });
        resulting.push(keyOfBlock(blockId));
      }
    });

    render();
    if (resulting.length > 0) setBlockSelection(resulting[0], resulting[resulting.length - 1]);
  }

  /**
   * Toggle an inline mark across every selected text unit.
   * @param {"bold" | "italic" | "underline" | "strike" | "code"} mark
   * @returns {boolean}
   */
  function toggleMarkOnSelection(mark) {
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
    const remove = allRuns.every((run) => run.marks?.[mark]);

    /** @param {InlineRun[]} runs */
    const restyle = (runs) =>
      mergeRuns(
        runs.map((run) => {
          const marks = { ...(run.marks ?? {}) };
          if (remove) delete marks[mark];
          else marks[mark] = true;
          return Object.keys(marks).length > 0 ? { text: run.text, marks } : { text: run.text };
        })
      );

    workspace.transact(`toggle ${mark}`, () => {
      for (const target of targets) {
        if (target.itemId) {
          const hit = locateItem(target.itemId);
          if (!hit) continue;
          const items = (hit.block.items ?? []).map((item) =>
            item.id === target.itemId ? { ...item, runs: restyle(item.runs ?? []) } : item
          );
          workspace.dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
        } else {
          const block = blockOf(target.blockId);
          if (block) {
            workspace.dispatch("setBlockRuns", {
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

  // -- structural edits --------------------------------------------------------

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
   * Insert a block and return its id, focusing it.
   * @param {{ type: string, [key: string]: unknown }} spec
   * @param {{ afterBlockId?: string, index?: number }} [position]
   * @returns {string | null}
   */
  function insertBlock(spec, position = {}) {
    const newBlockId = createId("block");
    workspace.dispatch("insertBlock", { pageId, block: spec, newBlockId, ...position });
    render();
    focusBlock(newBlockId, "start");
    return newBlockId;
  }

  /**
   * Insert plain text at the caret of a code block.
   * @param {HTMLElement} el
   * @param {string} text
   */
  function insertTextInCode(el, text) {
    const current = normalizeText(el.textContent ?? "");
    const { start, end } = selectionOffsets(el);
    el.textContent = current.slice(0, start) + text + current.slice(end);
    placeCaret(el, start + text.length);
    commitEditable(el);
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
          workspace.dispatch("updateBlock", { pageId, blockId, patch: { text: text.slice(0, -1) } });
          workspace.dispatch("insertBlock", {
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
    const empty = runsToPlainText(runs).trim().length === 0;
    const nested = findContainer(content(), blockId)?.parent != null;

    // Enter on an empty nested block lifts it out of the list item.
    if (empty && nested) {
      workspace.dispatch("outdentBlock", { pageId, blockId });
      render();
      focusKey(blockId, "start");
      return;
    }

    // Enter on an empty quote ends it: the block becomes a plain paragraph.
    if (block.type === "quote" && empty) {
      workspace.dispatch("changeBlockType", { pageId, blockId, type: "paragraph" });
      render();
      focusKey(blockId, "start");
      return;
    }

    // Enter never duplicates the block kind: whatever follows is a new paragraph.
    const { left, right } = splitRunsAt(runs, caretOffset(el));
    const newId = createId("block");
    workspace.transact("split block", () => {
      workspace.dispatch("setBlockRuns", { pageId, blockId, runs: left });
      workspace.dispatch("insertBlock", {
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
    const empty = (el.textContent ?? "").trim().length === 0;

    if (empty) {
      const parent = findContainer(content(), block.id)?.parent;
      if (parent) {
        // Nested: the item moves up one level and stays an item.
        workspace.dispatch("outdentListItem", { pageId, blockId: block.id, itemId });
        render();
        focusKey(unitKey(locateItem(itemId)?.block.id ?? parent.blockId, itemId), "start");
      } else {
        // Top level: the item ends the list and becomes a paragraph.
        const newId = createId("block");
        workspace.dispatch("outdentListItem", { pageId, blockId: block.id, itemId, newBlockId: newId });
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
    workspace.dispatch("updateBlock", { pageId, blockId: block.id, patch: { items: nextItems } });
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
          workspace.dispatch("outdentListItem", { pageId, blockId, itemId });
          render();
          focusKey(unitKey(locateItem(itemId)?.block.id ?? blockId, itemId), "start");
        } else {
          const newId = createId("block");
          workspace.dispatch("outdentListItem", { pageId, blockId, itemId, newBlockId: newId });
          render();
          focusKey(newId, "start");
        }
        return;
      }
      const previous = items[at - 1];
      const current = items[at];
      const merged = mergeRuns([...(previous.runs ?? []), ...runsOf(el)]);
      const offset = runsToPlainText(previous.runs ?? []).length;
      const children = [...(previous.children ?? []), ...(current.children ?? [])];
      const nextItems = items.slice();
      nextItems[at - 1] = { ...previous, runs: merged, ...(children.length > 0 ? { children } : {}) };
      nextItems.splice(at, 1);
      workspace.dispatch("updateBlock", { pageId, blockId, patch: { items: nextItems } });
      render();
      focusKey(unitKey(blockId, previous.id), offset);
      return;
    }

    // First block nested in a list item: lift it out.
    if (where?.parent && where.index === 0) {
      workspace.dispatch("outdentBlock", { pageId, blockId });
      render();
      focusKey(blockId, "start");
      return;
    }

    const previousKey = neighborKey(key, -1, false);
    if (!previousKey) {
      // Start of the document: a styled block falls back to a plain paragraph.
      if (block.type !== "paragraph") {
        workspace.dispatch("changeBlockType", { pageId, blockId, type: "paragraph" });
        render();
        focusKey(blockId, "start");
      }
      return;
    }
    const target = parseKey(previousKey);
    const previous = blockOf(target.blockId);
    if (!previous || !isTextual(previous)) return;

    const appended = block.type === "code" ? runsOfUnit(blockId) : runsOf(el);
    const mergeOffset = runsToPlainText(runsOfUnit(previousKey)).length;

    workspace.transact("merge blocks", () => {
      if (previous.type === "code") {
        workspace.dispatch("updateBlock", {
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
          workspace.dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
        }
      } else {
        workspace.dispatch("setBlockRuns", {
          pageId,
          blockId: previous.id,
          runs: mergeRuns([...(previous.runs ?? []), ...appended])
        });
      }
      workspace.dispatch("deleteBlock", { pageId, blockId });
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
          workspace.dispatch("indentListItem", { pageId, blockId, itemId });
        }
      } else {
        // Nested items lift one level; a top-level item leaves the list as a paragraph.
        newId = createId("block");
        workspace.dispatch("outdentListItem", { pageId, blockId, itemId, newBlockId: newId });
      }
      render();
      const hit = locateItem(itemId);
      if (hit) focusKey(unitKey(hit.block.id, itemId), offset);
      else if (newId && blockOf(newId)) focusKey(newId, offset);
      return true;
    }

    if (!shift && canIndentBlock(content(), blockId)) {
      workspace.dispatch("indentBlock", { pageId, blockId });
    } else if (shift && canOutdentBlock(content(), blockId)) {
      workspace.dispatch("outdentBlock", { pageId, blockId });
    } else {
      // Nothing to nest under / lift out of: still swallow Tab so focus stays in the page.
      return true;
    }
    render();
    focusKey(blockId, offset);
    return true;
  }

  // -- marks -------------------------------------------------------------------

  /**
   * Toggle an inline mark on the current selection.
   * @param {"bold" | "italic" | "underline" | "strike" | "code"} mark
   * @returns {boolean}
   */
  function toggleMark(mark) {
    if (sel) return toggleMarkOnSelection(mark);
    const el = activeEditable();
    if (!el) return false;
    const selection = el.ownerDocument.getSelection?.();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || range.collapsed) return false;

    const tag = MARK_TAG[mark];
    const existing = closestMark(range.commonAncestorContainer, tag, el);
    if (existing) {
      unwrap(existing);
    } else if (typeof el.ownerDocument.execCommand === "function" && EXEC_COMMAND[mark]) {
      let ok = false;
      try {
        ok = el.ownerDocument.execCommand(EXEC_COMMAND[mark], false);
      } catch {
        ok = false;
      }
      if (!ok) wrapRange(range, tag);
    } else {
      wrapRange(range, tag);
    }

    commitEditable(el);
    notifyActiveChange();
    return true;
  }

  /**
   * Set or clear a link on the current selection.
   * @param {string} url Empty string removes the link.
   * @returns {boolean}
   */
  function setLink(url) {
    const el = activeEditable();
    if (!el) return false;
    const selection = el.ownerDocument.getSelection?.();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range) return false;

    const existing = closestMark(range.commonAncestorContainer, "a", el);
    if (!url) {
      if (existing) unwrap(existing);
    } else if (existing) {
      existing.setAttribute("href", url);
    } else if (!range.collapsed) {
      const anchor = el.ownerDocument.createElement("a");
      anchor.setAttribute("href", url);
      try {
        anchor.append(range.extractContents());
        range.insertNode(anchor);
      } catch {
        return false;
      }
    } else {
      return false;
    }

    commitEditable(el);
    notifyActiveChange();
    return true;
  }

  /**
   * @param {Node} node
   * @param {string} tag
   * @param {Element} boundary
   * @returns {Element | null}
   */
  function closestMark(node, tag, boundary) {
    let current = node instanceof Element ? node : node.parentElement;
    while (current && current !== boundary) {
      if (current.tagName.toLowerCase() === tag) return current;
      current = current.parentElement;
    }
    return null;
  }

  /**
   * @param {Element} element_
   */
  function unwrap(element_) {
    const parent = element_.parentNode;
    if (!parent) return;
    while (element_.firstChild) parent.insertBefore(element_.firstChild, element_);
    parent.removeChild(element_);
  }

  /**
   * @param {Range} range
   * @param {string} tag
   */
  function wrapRange(range, tag) {
    const doc = range.startContainer.ownerDocument ?? document;
    const wrapper = doc.createElement(tag);
    try {
      wrapper.append(range.extractContents());
      range.insertNode(wrapper);
    } catch {
      return;
    }
    const selection = doc.getSelection?.();
    if (selection) {
      const next = doc.createRange();
      next.selectNodeContents(wrapper);
      selection.removeAllRanges();
      selection.addRange(next);
    }
  }

  // -- active block info -------------------------------------------------------

  /**
   * @typedef {object} ActiveInfo
   * @property {string | null} blockId
   * @property {string | null} itemId
   * @property {string | null} type
   * @property {number | null} level
   * @property {boolean | null} ordered
   * @property {number} selectionSize Units covered by block selection (0 when none).
   * @property {boolean} canIndent Whether Tab would nest the active unit.
   * @property {boolean} canOutdent Whether Shift+Tab would lift the active unit.
   */

  /** @returns {boolean} */
  function canIndentActive() {
    if (!activeBlockId) return false;
    const block = blockOf(activeBlockId);
    if (!block || block.type === "code") return false;
    if (activeItemId) return canIndentItem(content(), activeBlockId, activeItemId);
    return canIndentBlock(content(), activeBlockId);
  }

  /** @returns {boolean} */
  function canOutdentActive() {
    if (!activeBlockId) return false;
    const block = blockOf(activeBlockId);
    if (!block || block.type === "code") return false;
    // A top-level list item can always leave its list (it becomes a paragraph).
    if (activeItemId) return true;
    return canOutdentBlock(content(), activeBlockId);
  }

  /** @returns {ActiveInfo} */
  function activeInfo() {
    const block = activeBlockId ? blockOf(activeBlockId) : undefined;
    return {
      blockId: block?.id ?? null,
      itemId: activeItemId,
      type: block?.type ?? null,
      level: typeof block?.level === "number" ? block.level : null,
      ordered: typeof block?.ordered === "boolean" ? block.ordered : null,
      selectionSize: selectedKeys().length,
      canIndent: Boolean(block) && canIndentActive(),
      canOutdent: Boolean(block) && canOutdentActive()
    };
  }

  function notifyActiveChange() {
    options.onActiveChange?.(activeInfo());
  }

  /**
   * @param {Node | null} node
   */
  function setActiveFromNode(node) {
    const el = editableFrom(node);
    if (!el) return;
    const blockId = el.getAttribute("data-block-id");
    const itemId = el.getAttribute("data-item-id");
    if (blockId === activeBlockId && itemId === activeItemId) return;
    setActive(blockId, itemId);
  }

  /**
   * @param {Node | null} node
   * @returns {string | null} Key of the nearest unit around a node.
   */
  function unitKeyFrom(node) {
    const start = node instanceof Element ? node : node?.parentElement ?? null;
    const unit = start?.closest("[data-unit]");
    return unit && element.contains(unit) ? unit.getAttribute("data-unit") : null;
  }

  // -- events ------------------------------------------------------------------

  element.addEventListener("focusin", (event) => setActiveFromNode(/** @type {Node} */ (event.target)));

  element.addEventListener("mousedown", (event) => {
    const pointer = /** @type {MouseEvent} */ (event);
    if (pointer.button !== 0) return;
    const key = unitKeyFrom(/** @type {Node} */ (pointer.target));
    if (sel) clearBlockSelection();

    // Shift-click in another unit selects everything in between.
    const activeKey = activeBlockId ? unitKey(activeBlockId, activeItemId) : null;
    if (pointer.shiftKey && key && activeKey && key !== activeKey && unitElement(activeKey)) {
      pointer.preventDefault();
      setBlockSelection(activeKey, key);
      return;
    }

    dragAnchor = key;
    setActiveFromNode(/** @type {Node} */ (pointer.target));
  });

  element.addEventListener("mousemove", (event) => {
    const pointer = /** @type {MouseEvent} */ (event);
    if (!dragAnchor || !(pointer.buttons & 1)) return;
    const key = unitKeyFrom(/** @type {Node} */ (pointer.target));
    if (!key) return;
    if (!sel && key === dragAnchor) return;
    setBlockSelection(dragAnchor, key);
  });

  const onMouseUp = () => {
    dragAnchor = null;
  };
  element.ownerDocument.addEventListener("mouseup", onMouseUp);

  element.addEventListener("input", (event) => {
    const el = editableFrom(/** @type {Node} */ (event.target));
    if (el) {
      setActiveFromNode(el);
      commitEditable(el);
    }
  });

  element.addEventListener("paste", (event) => {
    const el = editableFrom(/** @type {Node} */ (event.target));
    if (!el || el.getAttribute("data-block-type") === "paragraph") return;
    if (!el.matches("code[data-block-id]")) return;
    const clipboard = /** @type {ClipboardEvent} */ (event).clipboardData;
    const text = clipboard?.getData("text/plain");
    if (typeof text !== "string") return;
    event.preventDefault();
    insertTextInCode(el, text.replace(/\r\n?/g, "\n"));
  });

  /**
   * Keys while units (not text) are selected.
   * @param {KeyboardEvent} keyboard
   */
  function handleSelectionKey(keyboard) {
    if (!sel) return;
    const mod = keyboard.metaKey || keyboard.ctrlKey;
    const key = keyboard.key;

    if (key === "Backspace" || key === "Delete") {
      keyboard.preventDefault();
      deleteSelection();
    } else if (key === "Escape" || key === "Enter") {
      keyboard.preventDefault();
      const target = sel.focus;
      focusKey(target, "end");
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      keyboard.preventDefault();
      const next = neighborKey(sel.focus, key === "ArrowUp" ? -1 : 1, false);
      if (keyboard.shiftKey) {
        if (next) setBlockSelection(sel.anchor, next);
      } else {
        const to = next ?? sel.focus;
        setBlockSelection(to, to);
      }
    } else if (mod && !keyboard.altKey) {
      const lower = key.toLowerCase();
      if (lower === "a") {
        keyboard.preventDefault();
        selectAllUnits();
      } else if (lower === "b" || lower === "i" || lower === "u") {
        keyboard.preventDefault();
        toggleMarkOnSelection(lower === "b" ? "bold" : lower === "i" ? "italic" : "underline");
      }
    }
  }

  element.addEventListener("keydown", (event) => {
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (sel && keyboard.target === element) {
      handleSelectionKey(keyboard);
      return;
    }
    const el = editableFrom(/** @type {Node} */ (keyboard.target));
    if (!el) return;
    const mod = keyboard.metaKey || keyboard.ctrlKey;
    const key = keyOfEditable(el);
    const { start, end } = selectionOffsets(el);
    const length = (el.textContent ?? "").length;

    if (mod && !keyboard.shiftKey && !keyboard.altKey) {
      const lower = keyboard.key.toLowerCase();
      if (lower === "b" || lower === "i" || lower === "u") {
        keyboard.preventDefault();
        toggleMark(lower === "b" ? "bold" : lower === "i" ? "italic" : "underline");
        return;
      }
      // Select-all grows: first the unit's text, then every unit in the document.
      if (lower === "a" && (length === 0 || (start === 0 && end === length))) {
        keyboard.preventDefault();
        selectAllUnits();
        return;
      }
    }

    if (keyboard.key === "Escape" && !mod) {
      keyboard.preventDefault();
      setBlockSelection(key, key);
      return;
    }

    if (keyboard.key === "Tab" && !mod && !keyboard.altKey) {
      if (handleTab(el, keyboard.shiftKey)) keyboard.preventDefault();
      return;
    }

    if (keyboard.key === "Enter" && !keyboard.shiftKey && !mod) {
      keyboard.preventDefault();
      handleEnter(el);
      return;
    }

    if (keyboard.key === "Backspace" && start === 0 && end === 0) {
      keyboard.preventDefault();
      handleBackspace(el);
      return;
    }

    if ((keyboard.key === "ArrowUp" || keyboard.key === "ArrowDown") && !mod && !keyboard.altKey) {
      const up = keyboard.key === "ArrowUp";
      const atEdge = up ? start === 0 : end === length;
      if (!atEdge) return;
      if (keyboard.shiftKey) {
        // Shift+arrow past the edge of a block grows the selection to whole blocks.
        const next = neighborKey(key, up ? -1 : 1, false);
        if (next) {
          keyboard.preventDefault();
          setBlockSelection(key, next);
        }
        return;
      }
      if (start !== end) return;
      const next = neighborKey(key, up ? -1 : 1, true);
      if (next) {
        keyboard.preventDefault();
        focusKey(next, up ? "end" : "start");
      }
    }
  });

  // -- toolbar / external API --------------------------------------------------

  /**
   * Apply a block type to the active block, or to every selected unit.
   * @param {{ type: string, level?: number, ordered?: boolean }} spec
   */
  function setActiveType(spec) {
    if (sel) {
      applyTypeToSelection(spec);
      return;
    }
    if (!activeBlockId || !blockOf(activeBlockId)) {
      insertAtEnd(spec);
      return;
    }
    const active = blockOf(activeBlockId);
    if (active?.type === "list" && activeItemId) {
      const hit = locateItem(activeItemId);
      if (spec.type === "list") {
        // Same kind: only the ordered/bulleted flavour can change.
        if (hit && spec.ordered !== undefined && spec.ordered !== Boolean(hit.block.ordered)) {
          workspace.dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { ordered: spec.ordered } });
          render();
        }
        return;
      }
      if (hit) {
        // Only the item under the caret changes type; the rest of the list stays a list.
        const newId = createId("block");
        const offset = activeEditable() ? caretOffset(/** @type {HTMLElement} */ (activeEditable())) : "end";
        workspace.dispatch("extractListItem", {
          pageId,
          blockId: hit.block.id,
          itemId: hit.item.id,
          type: spec.type,
          fields: spec.level !== undefined ? { level: spec.level } : {},
          newBlockId: newId
        });
        render();
        focusKey(newId, offset);
        return;
      }
    }
    /** @type {Record<string, unknown>} */
    const fields = {};
    if (spec.level !== undefined) fields.level = spec.level;
    if (spec.ordered !== undefined) fields.ordered = spec.ordered;
    const keep = activeBlockId;
    const offset = activeEditable() ? caretOffset(/** @type {HTMLElement} */ (activeEditable())) : "end";
    workspace.dispatch("changeBlockType", { pageId, blockId: keep, type: spec.type, fields });
    render();
    if (spec.type === "list") focusBlock(keep, "end");
    else focusKey(keep, offset);
  }

  /** Nest the active unit (or each selected unit) one level deeper. */
  function indent() {
    const el = activeEditable();
    if (el) handleTab(el, false);
  }

  /** Lift the active unit one level. */
  function outdent() {
    const el = activeEditable();
    if (el) handleTab(el, true);
  }

  /**
   * @param {{ type: string, [key: string]: unknown }} spec
   * @returns {string | null}
   */
  function insertAfterActive(spec) {
    if (!activeBlockId || !blockOf(activeBlockId)) return insertAtEnd(spec);
    return insertBlock(spec, { afterBlockId: activeBlockId });
  }

  /**
   * @param {{ type: string, [key: string]: unknown }} spec
   * @returns {string | null}
   */
  function insertAtEnd(spec) {
    return insertBlock(spec, { index: order().length });
  }

  // -- context menu ------------------------------------------------------------

  const popovers = createPopoverHost(element.ownerDocument.body);

  /** Delete the selected units, or the unit under the caret. */
  function deleteActive() {
    if (!sel) {
      if (!activeBlockId || !blockOf(activeBlockId)) return;
      const key = unitKey(activeBlockId, activeItemId);
      setBlockSelection(key, key);
    }
    deleteSelection();
  }

  /** @returns {boolean} Whether text (or whole blocks) are selected for formatting. */
  function hasTextSelection() {
    if (sel) return true;
    const selection = element.ownerDocument.getSelection?.();
    return Boolean(selection && selection.rangeCount > 0 && !selection.getRangeAt(0).collapsed);
  }

  /** @param {"copy" | "cut"} command */
  function clipboardCommand(command) {
    const doc = element.ownerDocument;
    if (typeof doc.execCommand === "function") doc.execCommand(command);
  }

  /** Paste plain text from the system clipboard at the caret. */
  async function pasteFromClipboard() {
    const text = await element.ownerDocument.defaultView?.navigator?.clipboard?.readText?.();
    const el = activeEditable();
    if (!text || !el) return;
    el.focus();
    if (el.matches("code[data-block-id]")) insertTextInCode(el, text.replace(/\r\n?/g, "\n"));
    else element.ownerDocument.execCommand?.("insertText", false, text.replace(/\s*\r?\n\s*/g, " "));
  }

  /** @param {{ x: number, y: number }} point */
  function openContextMenu(point) {
    const info = activeInfo();
    const formatting = hasTextSelection() && info.type !== "code";
    /** @param {string} label @param {string} iconName @param {string} action @param {() => void} run @param {Record<string, unknown>} [extra] */
    const item = (label, iconName, action, run, extra = {}) => ({
      label,
      icon: iconName,
      attrs: { "data-action": action },
      action: run,
      ...extra
    });
    /** @param {string} label @param {string} iconName @param {{ type: string, level?: number, ordered?: boolean }} spec @param {string} id */
    const turnInto = (label, iconName, spec, id) =>
      item(label, iconName, "ctx-block-type", () => setActiveType(spec), { attrs: { "data-action": "ctx-block-type", "data-type": id } });
    /** @param {string} label @param {"bold" | "italic" | "underline" | "strike" | "code"} mark */
    const markItem = (label, mark) =>
      item(label, mark, "ctx-mark", () => toggleMark(mark), {
        disabled: !formatting,
        attrs: { "data-action": "ctx-mark", "data-mark": mark }
      });

    /** @type {import("./popover.js").MenuItem[]} */
    const items = [
      item("Cut", "cut", "ctx-cut", () => clipboardCommand("cut"), { disabled: !hasTextSelection() }),
      item("Copy", "copy", "ctx-copy", () => clipboardCommand("copy"), { disabled: !hasTextSelection() }),
      item("Paste", "paste", "ctx-paste", () => void pasteFromClipboard(), { disabled: !info.blockId || Boolean(sel) }),
      { separator: true },
      markItem("Bold", "bold"),
      markItem("Italic", "italic"),
      markItem("Underline", "underline"),
      markItem("Strikethrough", "strike"),
      markItem("Inline code", "code"),
      { separator: true },
      {
        label: "Turn into",
        icon: "paragraph",
        attrs: { "data-action": "ctx-turn-into" },
        submenu: [
          turnInto("Paragraph", "paragraph", { type: "paragraph" }, "paragraph"),
          turnInto("Heading 1", "h1", { type: "heading", level: 1 }, "heading-1"),
          turnInto("Heading 2", "h2", { type: "heading", level: 2 }, "heading-2"),
          turnInto("Heading 3", "h3", { type: "heading", level: 3 }, "heading-3"),
          turnInto("List", "list", { type: "list" }, "list"),
          turnInto("Quote", "quote", { type: "quote" }, "quote"),
          turnInto("Code block", "code-block", { type: "code" }, "code")
        ]
      },
      { separator: true },
      item("Indent", "indent", "ctx-indent", () => indent(), { disabled: !info.canIndent }),
      item("Outdent", "outdent", "ctx-outdent", () => outdent(), { disabled: !info.canOutdent }),
      { separator: true },
      item("Insert paragraph below", "paragraph", "ctx-insert-paragraph", () => insertAfterActive({ type: "paragraph" })),
      item("Insert divider below", "divider", "ctx-insert-divider", () => insertAfterActive({ type: "divider" })),
      { separator: true },
      item(sel && selectedKeys().length > 1 ? "Delete blocks" : "Delete block", "clear", "ctx-delete", () => deleteActive(), {
        danger: true,
        disabled: !info.blockId
      })
    ];
    popovers.showAt(point, buildMenu(items, popovers.close, (name) => icon(name, { size: 16 })), {
      class: "context-menu"
    });
  }

  /**
   * Key of the unit closest to a vertical position, for right-clicks that land in
   * the gaps and margins around the blocks. Without layout (no unit has a height)
   * the active unit, else the last one, stands in.
   * @param {number} clientY
   * @returns {string | null}
   */
  function nearestUnitKey(clientY) {
    const units = [...element.querySelectorAll("[data-unit]")];
    if (units.length === 0) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const unit of units) {
      const rect = unit.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = unit;
      }
    }
    if (best) return best.getAttribute("data-unit");
    if (activeBlockId && blockOf(activeBlockId)) {
      const active = unitKey(activeBlockId, activeItemId);
      if (unitElement(active)) return active;
    }
    return units[units.length - 1].getAttribute("data-unit");
  }

  element.addEventListener("contextmenu", (event) => {
    const pointer = /** @type {MouseEvent} */ (event);
    const key = unitKeyFrom(/** @type {Node} */ (pointer.target)) ?? nearestUnitKey(pointer.clientY);
    // No blocks at all: nothing to act on, so leave the browser's menu alone.
    if (!key) return;
    pointer.preventDefault();
    if (!(sel && selectedKeys().includes(key))) {
      if (sel) clearBlockSelection();
      const { blockId, itemId } = parseKey(key);
      if (blockId !== activeBlockId || itemId !== activeItemId) setActive(blockId, itemId);
    }
    openContextMenu({ x: pointer.clientX, y: pointer.clientY });
  });

  // Store subscription: skip re-render for inline-only commits so the caret stays.
  const unsubscribe = workspace.events.on("change", (event) => {
    const payload = /** @type {{ kind?: string, commands?: string[] }} */ (event ?? {});
    if (
      payload.kind === "commit" &&
      Array.isArray(payload.commands) &&
      payload.commands.length > 0 &&
      payload.commands.every((command) => INLINE_COMMITS.has(command))
    ) {
      options.onChange?.();
      return;
    }
    render();
    const staleItem = activeItemId !== null && !locateItem(activeItemId);
    if ((activeBlockId && !blockOf(activeBlockId)) || staleItem) {
      activeBlockId = null;
      activeItemId = null;
      notifyActiveChange();
    }
    options.onChange?.();
  });

  render();

  return {
    element,
    refresh: render,
    focusBlock,
    getActiveBlockId: () => activeBlockId,
    activeInfo,
    setActiveType,
    insertAfterActive,
    insertAtEnd,
    toggleMark,
    setLink,
    indent,
    outdent,
    getSelectedUnits: selectedKeys,
    clearSelection: clearBlockSelection,
    openContextMenu,
    destroy: () => {
      unsubscribe();
      popovers.destroy();
      element.ownerDocument.removeEventListener("mouseup", onMouseUp);
    }
  };
}
