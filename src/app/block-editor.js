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
import { ensureDocumentContent } from "../document/model.js";
import { renderBlock, renderRuns } from "../document/render.js";
import { h, clear } from "./dom.js";
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
  const element = h("div", { class: "document-editor", role: "group", "aria-label": "Document body" });
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
        li.className = "block-item";
        li.setAttribute("contenteditable", "true");
        li.setAttribute("data-block-id", block.id);
        li.setAttribute("data-item-id", item.id);
        if ((item.runs ?? []).length === 0) li.setAttribute("data-placeholder", "List item");
        li.append(renderRuns(item.runs ?? [], renderOptions));
        element_.append(li);
      }
      return element_;
    }
    if (block.type === "code") {
      const pre = document.createElement("pre");
      pre.className = "block block-code";
      pre.setAttribute("data-block-id", block.id);
      pre.setAttribute("data-block-type", "code");
      const code = document.createElement("code");
      code.setAttribute("contenteditable", "true");
      code.setAttribute("data-block-id", block.id);
      code.setAttribute("data-placeholder", "Code");
      code.textContent = block.text ?? "";
      pre.append(code);
      return pre;
    }
    const rendered = renderBlock(block, renderOptions);
    if (!rendered) return null;
    rendered.classList.add("block");
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
      return;
    }
    for (const block of blocks) {
      const el = renderEditable(block);
      if (el) element.append(el);
    }
  }

  // -- element lookup ----------------------------------------------------------

  /** @param {string | null} blockId @param {string | null} [itemId] @returns {HTMLElement | null} */
  function findEditable(blockId, itemId = null) {
    if (!blockId) return null;
    if (itemId) {
      return /** @type {HTMLElement | null} */ (
        element.querySelector(`[data-block-id="${blockId}"][data-item-id="${itemId}"]`)
      );
    }
    const matches = element.querySelectorAll(`[contenteditable="true"][data-block-id="${blockId}"]`);
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
      const current = (block.items ?? []).find((item) => item.id === itemId);
      if (current && !runsEqual(current.runs ?? [], runs)) {
        const items = (block.items ?? []).map((item) => (item.id === itemId ? { ...item, runs } : item));
        workspace.dispatch("updateBlock", { pageId, blockId, patch: { items } });
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

  // -- structural edits --------------------------------------------------------

  /** @param {string} blockId @returns {string | null} */
  function previousBlockId(blockId) {
    const ids = order();
    const at = ids.indexOf(blockId);
    return at > 0 ? ids[at - 1] : null;
  }

  /** @param {string} blockId @returns {string | null} */
  function nextBlockId(blockId) {
    const ids = order();
    const at = ids.indexOf(blockId);
    return at !== -1 && at < ids.length - 1 ? ids[at + 1] : null;
  }

  /**
   * @param {Block} block
   * @returns {boolean}
   */
  function isTextual(block) {
    return TEXTUAL_TYPES.has(block.type);
  }

  /**
   * @param {Block} block
   * @returns {InlineRun[]}
   */
  function textRuns(block) {
    if (Array.isArray(block.runs)) return block.runs;
    if (block.type === "code") return block.text ? [{ text: block.text }] : [];
    if (Array.isArray(block.items)) return block.items.flatMap((item) => item.runs ?? []);
    return [];
  }

  /**
   * Insert a block and return its id, focusing it.
   * @param {{ type: string, [key: string]: unknown }} spec
   * @param {{ afterBlockId?: string, index?: number }} [position]
   * @returns {string | null}
   */
  function insertBlock(spec, position = {}) {
    workspace.dispatch("insertBlock", { pageId, block: spec, ...position });
    const inserted = findInsertedId(position);
    render();
    if (inserted) {
      activeBlockId = inserted;
      activeItemId = null;
      placeCaret(findEditable(inserted), "start");
      notifyActiveChange();
    }
    return inserted;
  }

  /**
   * Work out which block was just inserted, using the position we asked for.
   * @param {{ afterBlockId?: string, index?: number }} position
   * @returns {string | null}
   */
  function findInsertedId(position) {
    const ids = order();
    if (position.afterBlockId !== undefined) {
      const at = ids.indexOf(position.afterBlockId);
      return at !== -1 ? ids[at + 1] ?? null : null;
    }
    if (position.index !== undefined) return ids[position.index] ?? null;
    return ids[ids.length - 1] ?? null;
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
      const { left, right } = splitTextAt(text, caretOffset(el));
      workspace.transact("split code block", () => {
        workspace.dispatch("updateBlock", { pageId, blockId, patch: { text: left } });
        workspace.dispatch("insertBlock", {
          pageId,
          block: { type: "code", text: right },
          afterBlockId: blockId
        });
      });
      const newId = nextBlockId(blockId);
      render();
      if (newId) {
        activeBlockId = newId;
        activeItemId = null;
        placeCaret(findEditable(newId), "start");
        notifyActiveChange();
      }
      return;
    }

    const runs = runsOf(el);
    const { left, right } = splitRunsAt(runs, caretOffset(el));
    const newType = block.type === "heading" ? "paragraph" : block.type;
    workspace.transact("split block", () => {
      workspace.dispatch("setBlockRuns", { pageId, blockId, runs: left });
      workspace.dispatch("insertBlock", { pageId, block: { type: newType, runs: right }, afterBlockId: blockId });
    });
    const newId = nextBlockId(blockId);
    render();
    if (newId) {
      activeBlockId = newId;
      activeItemId = null;
      placeCaret(findEditable(newId), "start");
      notifyActiveChange();
    }
  }

  /**
   * Split a list item at the caret, or exit the list when empty.
   * @param {Block} block
   * @param {string} itemId
   * @param {HTMLElement} el
   */
  function splitListItem(block, itemId, el) {
    const items = block.items ?? [];
    const at = items.findIndex((item) => item.id === itemId);
    if (at === -1) return;
    const runs = runsOf(el);
    const empty = (el.textContent ?? "").trim().length === 0;

    if (empty) {
      if (items.length > 1) {
        const remaining = items.filter((item) => item.id !== itemId);
        const focusId = (at > 0 ? items[at - 1] : items[at + 1]).id;
        workspace.dispatch("updateBlock", { pageId, blockId: block.id, patch: { items: remaining } });
        render();
        activeBlockId = block.id;
        activeItemId = focusId;
        placeCaret(findEditable(block.id, focusId), "end");
        notifyActiveChange();
      } else {
        workspace.dispatch("changeBlockType", { pageId, blockId: block.id, type: "paragraph" });
        render();
        activeBlockId = block.id;
        activeItemId = null;
        placeCaret(findEditable(block.id), "end");
        notifyActiveChange();
      }
      return;
    }

    const { left, right } = splitRunsAt(runs, caretOffset(el));
    const newItem = { id: createId("item"), runs: right };
    const nextItems = items.slice();
    nextItems[at] = { ...items[at], runs: left };
    nextItems.splice(at + 1, 0, newItem);
    workspace.dispatch("updateBlock", { pageId, blockId: block.id, patch: { items: nextItems } });
    render();
    activeBlockId = block.id;
    activeItemId = newItem.id;
    placeCaret(findEditable(block.id, newItem.id), "start");
    notifyActiveChange();
  }

  /**
   * Backspace at the very start of a block: merge or delete.
   * @param {HTMLElement} el
   * @returns {boolean} Whether the default was handled.
   */
  function handleBackspace(el) {
    const blockId = el.getAttribute("data-block-id") ?? "";
    const itemId = el.getAttribute("data-item-id");
    const block = blockOf(blockId);
    if (!block) return true;

    if (block.type === "list" && itemId) {
      const items = block.items ?? [];
      const at = items.findIndex((item) => item.id === itemId);
      if (at <= 0) {
        if (items.length === 1) {
          workspace.dispatch("changeBlockType", { pageId, blockId, type: "paragraph" });
          render();
          activeBlockId = blockId;
          activeItemId = null;
          placeCaret(findEditable(blockId), "start");
          notifyActiveChange();
        }
        return true;
      }
      const previous = items[at - 1];
      const merged = mergeRuns([...(previous.runs ?? []), ...runsOf(el)]);
      const offset = runsToPlainText(previous.runs ?? []).length;
      const nextItems = items.slice();
      nextItems[at - 1] = { ...previous, runs: merged };
      nextItems.splice(at, 1);
      workspace.dispatch("updateBlock", { pageId, blockId, patch: { items: nextItems } });
      render();
      activeBlockId = blockId;
      activeItemId = previous.id;
      placeCaret(findEditable(blockId, previous.id), offset);
      notifyActiveChange();
      return true;
    }

    const previousId = previousBlockId(blockId);
    if (!previousId) return true;
    const previous = blockOf(previousId);
    if (!previous) return true;
    if (!isTextual(previous)) return true;

    const currentRuns = runsOf(el);
    const currentText = normalizeText(el.textContent ?? "");
    const mergeOffset = runsToPlainText(textRuns(previous)).length;

    if (previous.type === "code") {
      const appended = block.type === "code" ? currentText : runsToPlainText(currentRuns);
      workspace.dispatch("updateBlock", {
        pageId,
        blockId: previousId,
        patch: { text: `${previous.text ?? ""}${appended}` }
      });
    } else if (previous.type === "list") {
      const items = previous.items ?? [];
      if (items.length === 0) {
        workspace.dispatch("changeBlockType", { pageId, blockId: previousId, type: "paragraph" });
      }
      const last = items[items.length - 1];
      const mergedItems = items.slice();
      mergedItems[mergedItems.length - 1] = {
        ...last,
        runs: mergeRuns([...(last?.runs ?? []), ...blockItemsRuns(block, currentRuns)])
      };
      workspace.dispatch("updateBlock", { pageId, blockId: previousId, patch: { items: mergedItems } });
    } else {
      const merged = mergeRuns([...(previous.runs ?? []), ...blockItemsRuns(block, currentRuns)]);
      workspace.dispatch("setBlockRuns", { pageId, blockId: previousId, runs: merged });
    }

    workspace.dispatch("deleteBlock", { pageId, blockId });
    render();
    activeBlockId = previousId;
    activeItemId = previous.type === "list" ? (previous.items ?? []).slice(-1)[0]?.id ?? null : null;
    placeCaret(findEditable(previousId, activeItemId), mergeOffset);
    notifyActiveChange();
    return true;
  }

  /**
   * Runs to merge from a (possibly non-run) block being backspaced away.
   * @param {Block} block
   * @param {InlineRun[]} runs
   * @returns {InlineRun[]}
   */
  function blockItemsRuns(block, runs) {
    if (block.type === "list") return (block.items ?? []).flatMap((item) => item.runs ?? []);
    if (block.type === "code") return block.text ? [{ text: block.text }] : [];
    return runs;
  }

  // -- marks -------------------------------------------------------------------

  /**
   * Toggle an inline mark on the current selection.
   * @param {"bold" | "italic" | "underline" | "strike" | "code"} mark
   * @returns {boolean}
   */
  function toggleMark(mark) {
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
   */

  /** @returns {ActiveInfo} */
  function activeInfo() {
    const block = activeBlockId ? blockOf(activeBlockId) : undefined;
    return {
      blockId: block?.id ?? null,
      itemId: activeItemId,
      type: block?.type ?? null,
      level: typeof block?.level === "number" ? block.level : null,
      ordered: typeof block?.ordered === "boolean" ? block.ordered : null
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
    activeBlockId = blockId;
    activeItemId = itemId;
    notifyActiveChange();
  }

  // -- events ------------------------------------------------------------------

  element.addEventListener("focusin", (event) => setActiveFromNode(/** @type {Node} */ (event.target)));
  element.addEventListener("mousedown", (event) => setActiveFromNode(/** @type {Node} */ (event.target)));
  element.addEventListener("input", (event) => {
    const el = editableFrom(/** @type {Node} */ (event.target));
    if (el) {
      setActiveFromNode(el);
      commitEditable(el);
    }
  });

  element.addEventListener("keydown", (event) => {
    const keyboard = /** @type {KeyboardEvent} */ (event);
    const el = editableFrom(/** @type {Node} */ (keyboard.target));
    if (!el) return;
    const mod = keyboard.metaKey || keyboard.ctrlKey;

    if (mod && !keyboard.shiftKey && !keyboard.altKey) {
      const key = keyboard.key.toLowerCase();
      if (key === "b" || key === "i" || key === "u") {
        keyboard.preventDefault();
        toggleMark(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
        return;
      }
    }

    if (keyboard.key === "Enter" && !keyboard.shiftKey && !mod) {
      keyboard.preventDefault();
      handleEnter(el);
      return;
    }

    if (keyboard.key === "Backspace" && caretOffset(el) === 0) {
      keyboard.preventDefault();
      handleBackspace(el);
      return;
    }

    if (keyboard.key === "ArrowUp" && caretOffset(el) === 0) {
      const previousId = previousBlockId(el.getAttribute("data-block-id") ?? "");
      if (previousId) {
        keyboard.preventDefault();
        focusBlock(previousId, "end");
      }
      return;
    }

    if (keyboard.key === "ArrowDown") {
      const text = el.textContent ?? "";
      if (caretOffset(el) === text.length) {
        const nextId = nextBlockId(el.getAttribute("data-block-id") ?? "");
        if (nextId) {
          keyboard.preventDefault();
          focusBlock(nextId, "start");
        }
      }
    }
  });

  /** @param {string} blockId @param {"start" | "end" | number} [where] */
  function focusBlock(blockId, where = "end") {
    const block = blockOf(blockId);
    if (!block) return;
    const itemId = block.type === "list" ? (block.items ?? [])[0]?.id ?? null : null;
    activeBlockId = blockId;
    activeItemId = itemId;
    const el = findEditable(blockId, itemId);
    if (el) placeCaret(el, where);
    notifyActiveChange();
  }

  // -- toolbar / external API --------------------------------------------------

  /**
   * Apply a block type to the active block (toolbar).
   * @param {{ type: string, level?: number, ordered?: boolean }} spec
   */
  function setActiveType(spec) {
    if (!activeBlockId || !blockOf(activeBlockId)) {
      insertAtEnd(spec);
      return;
    }
    const fields = {};
    if (spec.level !== undefined) fields.level = spec.level;
    if (spec.ordered !== undefined) fields.ordered = spec.ordered;
    workspace.dispatch("changeBlockType", {
      pageId,
      blockId: activeBlockId,
      type: spec.type,
      fields
    });
    const keep = activeBlockId;
    render();
    focusBlock(keep, "end");
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
    if (activeBlockId && !blockOf(activeBlockId)) {
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
    destroy: () => unsubscribe()
  };
}
