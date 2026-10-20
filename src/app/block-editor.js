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
import { ensureSection } from "../references/catalog.js";
import {
  canIndentBlock,
  canIndentItem,
  canOutdentBlock,
  ensureDocumentContent,
  findContainer
} from "../document/model.js";
import { renderBlock, renderRuns } from "../document/render.js";
import { containerOf } from "../references/containers.js";
import { findSection, sectionBlockIds, sectionRunIds, sectionsCovering } from "../references/sections.js";
import { h, clear } from "./dom.js";
import { planBlockMove, promptName, referenceMenuItems, sectionMenuItems, showMenu } from "./handles.js";
import { icon } from "./icons.js";
import { NO_LINK, buildLinkCard, buildLinkForm, linkPages, normalizeLinkUrl, pageIdOfLink } from "./link-form.js";
import { guard } from "./notice.js";
import { buildMenu, createPopoverHost } from "./popover.js";
import { openExpressionEditor } from "./expression-editor.js";
import { openReferencePicker } from "./reference-picker.js";
import { createReferenceViews } from "./reference-view.js";
import { caretOffset, mergeRuns, modelLength, normalizeText, parseInlineRuns, runsEqual, runsToPlainText } from "./inline.js";
import { pageExists, pageInfo } from "../workspace/selectors.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../document/model.js").Block} Block */
/** @typedef {import("../document/model.js").InlineRun} InlineRun */

const RUN_TYPES = new Set(["paragraph", "heading", "quote"]);
const TEXTUAL_TYPES = new Set(["paragraph", "heading", "quote", "list", "code"]);
/** Commits made of these alone are typing: the DOM already shows them, so the editor keeps its caret. */
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
 * @param {InlineRun[]} runs
 * @returns {boolean} True when nothing readable and no reference is in the runs.
 */
function isBlankRuns(runs) {
  return runs.every((run) => !run.ref && run.text.trim().length === 0);
}

/**
 * @param {InlineRun[]} runs
 * @returns {number} Length as caret offsets count it (a reference is one character).
 */
function modelLength2(runs) {
  return runs.reduce((total, run) => total + run.text.length, 0);
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
 * Start and end of the current selection as character offsets in an element.
 * @param {Element} element
 * @returns {{ start: number, end: number }}
 */
function selectionOffsets(element) {
  const doc = element.ownerDocument;
  const length = modelLength(element);
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
    return modelLength(probe.cloneContents());
  };
  return {
    start: measure(range.startContainer, range.startOffset),
    end: measure(range.endContainer, range.endOffset)
  };
}

/**
 * The DOM position of a character offset, counting an inline reference as one character
 * and never entering it.
 * @param {Node} root
 * @param {number} target
 * @returns {{ container: Node, offset: number } | null}
 */
function pointAtOffset(root, target) {
  let remaining = target;
  /** @param {Node} node @returns {{ container: Node, offset: number } | null} */
  const visit = (node) => {
    const children = Array.from(node.childNodes);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child.textContent ?? "").length;
        if (remaining <= length) return { container: child, offset: remaining };
        remaining -= length;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (/** @type {Element} */ (child).hasAttribute("data-ref-id")) {
          if (remaining === 0) return { container: node, offset: i };
          remaining -= 1;
          if (remaining === 0) return { container: node, offset: i + 1 };
        } else {
          const found = visit(child);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(root);
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
    const point = pointAtOffset(element, where);
    if (point) {
      range.setStart(point.container, point.offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    range.selectNodeContents(element);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A store-shaped view of one section of a container, for an editor drawn inside an
 * embed. Reads see only the section's run of blocks as the document; every command
 * goes to the real workspace in one transaction, after which the section grows to
 * take in the blocks the command created next to it (Enter at the end of the run,
 * a block lifted out of a list), so edits made in an embed never leak out of it.
 * @param {any} host The real workspace.
 * @param {string} sectionId
 * @returns {any}
 */
function nestedStore(host, sectionId) {
  /** Grow the run over adjacent blocks that belong to it. */
  function fit(/** @type {Set<string>} */ belong) {
    const found = findSection(host.data, sectionId);
    if (!found) return;
    const { content } = found.container;
    const { startBlockId, endBlockId } = found.section.locator;
    const place = findContainer(content, startBlockId);
    if (!place) return;
    let first = place.index;
    let last = place.ids.indexOf(endBlockId);
    if (last < first) return;
    while (last + 1 < place.ids.length && belong.has(place.ids[last + 1])) last += 1;
    while (first > 0 && belong.has(place.ids[first - 1])) first -= 1;
    if (place.ids[first] !== startBlockId || place.ids[last] !== endBlockId) {
      host.dispatch("resizeSection", { sectionId, startBlockId: place.ids[first], endBlockId: place.ids[last] });
    }
  }

  return {
    events: { on: () => () => {} },
    get data() {
      return host.data;
    },
    getPage(/** @type {string} */ id) {
      const container = containerOf(host.data, id);
      if (!container) return undefined;
      const found = findSection(host.data, sectionId);
      const blockOrder = found && found.containerId === id ? sectionRunIds(container.content, found.section.locator) : [];
      return { ...container, content: { ...container.content, blockOrder } };
    },
    transact: (/** @type {string} */ label, /** @type {() => any} */ fn) => host.transact(label, fn),
    dispatch(/** @type {string} */ type, /** @type {any} */ payload, /** @type {any} */ dispatchOptions) {
      return host.transact(type, () => {
        const found = findSection(host.data, sectionId);
        const before = new Set(found ? Object.keys(found.container.content.blocks ?? {}) : []);
        const belong = new Set(found ? sectionBlockIds(found.container.content, found.section.locator) : []);
        const result = host.dispatch(type, payload, dispatchOptions);
        const after = findSection(host.data, sectionId);
        if (after) for (const id of Object.keys(after.container.content.blocks ?? {})) if (!before.has(id)) belong.add(id);
        fit(belong);
        return result;
      });
    }
  };
}

/**
 * Create a document editor bound to one page, or (with `options.sectionId`) to one
 * section of a container, which is how an embed is edited in place.
 *
 * @param {Workspace} hostWorkspace
 * @param {string} pageId Page, or the container that holds the section.
 * @param {{
 *   resolvePageTitle?: (id: string) => string | undefined,
 *   onActiveChange?: (info: ActiveInfo) => void,
 *   onChange?: () => void,
 *   sectionId?: string,
 *   origin?: string,
 *   navigate?: (pageId: string) => void
 * }} [options]
 * @returns {EditorHandle}
 */
export function createDocumentEditor(hostWorkspace, pageId, options = {}) {
  const nested = Boolean(options.sectionId);
  // One origin per editor tree: an embedded editor's typing is this editor's typing too.
  const origin = options.origin ?? createId("editor");
  const workspace = nested ? nestedStore(hostWorkspace, /** @type {string} */ (options.sectionId)) : hostWorkspace;
  const element = h("div", {
    class: `document-editor${nested ? " is-embedded" : ""}`,
    role: "group",
    "aria-label": "Document body",
    tabindex: "-1",
    "data-history": "model"
  });

  /** Dispatch as this editor, so its change events can be recognised as its own. */
  const dispatch = (/** @type {string} */ type, /** @type {any} */ payload) => workspace.dispatch(type, payload, { origin });

  /** Whether a node belongs to this editor rather than to an editor nested in it. */
  const owns = (/** @type {Node | null} */ node) => {
    const start = node instanceof Element ? node : (node?.parentElement ?? null);
    return !start || start.closest(".document-editor") === element;
  };
  /** @type {string | null} */
  let activeBlockId = null;
  /** @type {string | null} */
  let activeItemId = null;

  /** @type {any} Nested editor that currently has the caret, if any. */
  let focusedChild = null;
  const popovers = createPopoverHost(element.ownerDocument.body);

  const views = createReferenceViews({
    workspace: hostWorkspace,
    hostId: pageId,
    resolvePageTitle: options.resolvePageTitle,
    createEditor: (sectionId, containerId) => {
      /** @type {any} */
      const child = createDocumentEditor(hostWorkspace, containerId, {
        sectionId,
        origin,
        resolvePageTitle: options.resolvePageTitle,
        navigate: options.navigate,
        onActiveChange: () => {
          focusedChild = child;
          notifyActiveChange();
        }
      });
      return child;
    },
    onHandle: (record, anchor) => openReferenceMenu(record, anchor),
    onEditExpression: (record, frame) => editExpression(record, frame)
  });

  const renderOptions = {
    resolvePageTitle: options.resolvePageTitle,
    renderReference: (/** @type {Block} */ block) => views.render(block),
    renderInlineRef: (/** @type {any} */ ref) => views.renderInline(ref, element.clientWidth)
  };

  /** @returns {any} The nested editor to act through, when the caret is inside one. */
  function activeChild() {
    return focusedChild && views.childEditors().includes(focusedChild) && focusedChild.activeInfo().blockId
      ? focusedChild
      : null;
  }

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
    return [...element.querySelectorAll("[data-unit]")].filter(owns).map((el) => el.getAttribute("data-unit") ?? "");
  }

  /** @param {string} key @returns {HTMLElement | null} */
  function unitElement(key) {
    return /** @type {HTMLElement | null} */ ([...element.querySelectorAll(`[data-unit="${key}"]`)].find(owns) ?? null);
  }

  /** @param {HTMLElement | null} unit @returns {HTMLElement | null} */
  function editableOfUnit(unit) {
    if (!unit || unit.classList.contains("reference")) return null;
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
    handleTarget = null;
    views.begin();
    const c = content();
    const blocks = c.blockOrder.map((id) => c.blocks[id]).filter(Boolean);
    if (blocks.length === 0) {
      views.end();
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
    views.end();
    if (blockHandle) element.append(blockHandle);
    applySelection();
  }

  // -- element lookup ----------------------------------------------------------

  /** @param {string | null} blockId @param {string | null} [itemId] @returns {HTMLElement | null} */
  function findEditable(blockId, itemId = null) {
    if (itemId) {
      return /** @type {HTMLElement | null} */ (
        [...element.querySelectorAll(`[contenteditable="true"][data-item-id="${itemId}"]`)].find(owns) ?? null
      );
    }
    if (!blockId) return null;
    const matches = [
      ...element.querySelectorAll(`[contenteditable="true"][data-block-id="${blockId}"]:not([data-item-id])`)
    ].filter(owns);
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
        dispatch("updateBlock", { pageId, blockId, patch: { text } });
      }
      return;
    }

    const runs = parseInlineRuns(el);
    if (block.type === "list" && itemId) {
      const hit = locateItem(itemId);
      if (hit && !runsEqual(hit.item.runs ?? [], runs)) {
        const items = (hit.block.items ?? []).map((item) => (item.id === itemId ? { ...item, runs } : item));
        dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } });
      }
      return;
    }

    if (!runsEqual(block.runs ?? [], runs)) {
      dispatch("setBlockRuns", { pageId, blockId, runs });
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
    focusedChild = null;
    activeBlockId = blockId;
    activeItemId = itemId;
    if (blockHandle && !handleBusy) showHandleAt(blockId && blockOf(blockId) ? topLevelOf(blockId) : null);
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
    dispatch("insertBlock", { pageId, block: spec, newBlockId, ...position });
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
      const offset = modelLength2(previous.runs ?? []);
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
    const mergeOffset = modelLength2(runsOfUnit(previousKey));

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

  // -- marks -------------------------------------------------------------------

  /**
   * Toggle an inline mark on the current selection.
   * @param {"bold" | "italic" | "underline" | "strike" | "code"} mark
   * @returns {boolean}
   */
  function toggleMark(mark) {
    const child = activeChild();
    if (child) return child.toggleMark(mark);
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
   * @param {HTMLElement} el
   * @returns {Range | null} The live selection range when it sits inside `el`.
   */
  function rangeInside(el) {
    const selection = el.ownerDocument.getSelection?.();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    return range && el.contains(range.commonAncestorContainer) ? range : null;
  }

  /** @param {HTMLElement} el @returns {boolean} Whether links can live in this host. */
  const linkable = (el) => !el.matches("code[data-block-id]");

  /**
   * What the link controls need to know: whether the caret is in a link, its address and
   * text, and what is selected.
   * @returns {import("./link-form.js").LinkInfo}
   */
  function getLinkInfo() {
    const child = activeChild();
    if (child) return child.getLinkInfo();
    if (sel) {
      const urls = new Set();
      for (const key of selectedKeys()) {
        const { blockId, itemId } = parseKey(key);
        const block = blockOf(blockId);
        const runs = itemId ? (locateItem(itemId)?.item.runs ?? []) : (block?.runs ?? []);
        for (const run of runs) if (!run.ref) urls.add(run.marks?.link ?? "");
      }
      const only = urls.size === 1 ? [...urls][0] : "";
      return { canLink: true, inLink: only !== "", url: only, text: "", hasSelection: true, wholeBlocks: true };
    }
    const el = activeEditable();
    if (!el || !linkable(el)) return NO_LINK;
    const range = rangeInside(el);
    const anchor = range ? closestMark(range.commonAncestorContainer, "a", el) : null;
    const hasSelection = Boolean(range && !range.collapsed);
    return {
      canLink: true,
      inLink: Boolean(anchor),
      url: anchor?.getAttribute("href") ?? "",
      text: anchor ? (anchor.textContent ?? "") : hasSelection && range ? range.toString() : "",
      hasSelection,
      wholeBlocks: false
    };
  }

  /**
   * Set, edit or clear a link. Over selected text it links that text; inside a link it
   * changes the address (and the text, when given); at a bare caret with `text` it inserts
   * a new linked piece of text; for "" it removes the link under the selection. With whole
   * blocks selected it links every run in them.
   * @param {string} rawUrl Empty string removes the link.
   * @param {string} [text] Text to show (editing a link, or inserting at a caret).
   * @returns {boolean}
   */
  function setLink(rawUrl, text) {
    const child = activeChild();
    if (child) return child.setLink(rawUrl, text);
    const url = rawUrl ? normalizeLinkUrl(rawUrl) : "";
    if (rawUrl && !url) return false;
    if (sel) return setLinkOnSelection(url);
    const el = activeEditable();
    if (!el || !linkable(el)) return false;
    const doc = el.ownerDocument;
    const selection = doc.getSelection?.();
    const range = rangeInside(el);
    const intersecting = () =>
      range ? [...el.querySelectorAll("a")].filter((anchor) => range.intersectsNode(anchor)) : [];

    if (!url) {
      const existing = range ? closestMark(range.commonAncestorContainer, "a", el) : null;
      const targets = new Set([...(existing ? [existing] : []), ...(range?.collapsed ? [] : intersecting())]);
      if (targets.size === 0) return false;
      for (const anchor of targets) unwrap(anchor);
    } else {
      const existing = range ? closestMark(range.commonAncestorContainer, "a", el) : null;
      if (existing) {
        existing.setAttribute("href", url);
        if (text && text !== existing.textContent) existing.textContent = text;
      } else if (range && !range.collapsed) {
        const anchor = doc.createElement("a");
        anchor.setAttribute("href", url);
        try {
          // Extracting splits any link the selection only partly covers, so its outside
          // part keeps the old address; the covered part is re-linked below.
          anchor.append(range.extractContents());
          for (const inner of [...anchor.querySelectorAll("a")]) unwrap(inner);
          range.insertNode(anchor);
        } catch {
          return false;
        }
      } else {
        const anchor = doc.createElement("a");
        anchor.setAttribute("href", url);
        anchor.textContent = text || (pageIdOfLink(url) && options.resolvePageTitle?.(pageIdOfLink(url))) || url;
        const at = range ?? doc.createRange();
        if (!range) {
          at.selectNodeContents(el);
          at.collapse(false);
        }
        at.insertNode(anchor);
        const after = doc.createRange();
        after.setStartAfter(anchor);
        after.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(after);
      }
    }

    commitEditable(el);
    notifyActiveChange();
    return true;
  }

  /** @type {boolean} Whether the open popover is the click-on-a-link card. */
  let linkCardOpen = false;

  /**
   * Open the link form at the caret (ribbon, context menu, the link card).
   * @returns {boolean}
   */
  function openLinkEditor() {
    const child = activeChild();
    if (child) return child.openLinkEditor();
    const info = getLinkInfo();
    if (!info.canLink) return false;
    const el = activeEditable();
    const selection = element.ownerDocument.getSelection?.();
    const saved = !sel && selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    const restore = () => {
      if (!saved || !selection) return;
      selection.removeAllRanges();
      selection.addRange(saved);
    };
    const target = (saved && typeof saved.getBoundingClientRect === "function" ? saved.getBoundingClientRect() : null) ?? { left: 0, bottom: 0, width: 0, height: 0 };
    const box = target.width || target.height ? target : (el ?? element).getBoundingClientRect();
    linkCardOpen = false;
    const close = () => {
      popovers.close();
      restore();
      if (!sel) el?.focus?.();
    };
    const form = buildLinkForm({
      info,
      pages: linkPages(hostWorkspace),
      onApply: ({ url, text }) => {
        restore();
        setLink(url, text);
      },
      onRemove: () => {
        restore();
        setLink("");
      },
      close
    });
    popovers.showAt({ x: box.left, y: box.bottom + 4 }, form, { class: "popover-dialog", keepFocus: true });
    return true;
  }

  /**
   * The card under a clicked link: where it goes, Edit and Remove.
   * @param {HTMLAnchorElement} anchor
   * @param {HTMLElement} el The editable host holding the link.
   */
  function openLinkCard(anchor, el) {
    const url = anchor.getAttribute("href") ?? "";
    const rect = anchor.getBoundingClientRect();
    const pageId = pageIdOfLink(url);
    const target = pageId ? pageInfo(hostWorkspace, pageId) : undefined;
    const card = buildLinkCard({
      url,
      page: pageId
        ? target
          ? {
              title: target.title || "Untitled",
              type: target.type,
              onOpen: () => {
                popovers.close();
                linkCardOpen = false;
                options.navigate?.(pageId);
              }
            }
          : null
        : undefined,
      onEdit: () => {
        popovers.close();
        linkCardOpen = false;
        openLinkEditor();
      },
      onRemove: () => {
        popovers.close();
        linkCardOpen = false;
        unwrap(anchor);
        commitEditable(el);
        notifyActiveChange();
      }
    });
    popovers.showAt({ x: rect.left, y: rect.bottom + 4 }, card, { class: "popover-dialog link-card-popover" });
    linkCardOpen = true;
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
    const child = activeChild();
    if (child) return child.activeInfo();
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
    return unit && element.contains(unit) && owns(unit) ? unit.getAttribute("data-unit") : null;
  }

  // -- events ------------------------------------------------------------------

  element.addEventListener("focusin", (event) => {
    if (owns(/** @type {Node} */ (event.target))) setActiveFromNode(/** @type {Node} */ (event.target));
  });

  /** @type {{ x: number, y: number } | null} Where the last primary press landed. */
  let lastPress = null;

  element.addEventListener("mousedown", (event) => {
    const pointer = /** @type {MouseEvent} */ (event);
    if (pointer.button !== 0 || !owns(/** @type {Node} */ (pointer.target))) return;
    if (!nested && pointer.target === element && clickedBelowLastBlock(pointer)) {
      pointer.preventDefault();
      if (sel) clearBlockSelection();
      appendOrFocusTrailingParagraph();
      return;
    }
    lastPress = { x: pointer.clientX, y: pointer.clientY };
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

  element.addEventListener("click", (event) => {
    const pointer = /** @type {MouseEvent} */ (event);
    if (pointer.button !== 0 || !owns(/** @type {Node} */ (pointer.target))) return;
    const target = pointer.target instanceof Element ? pointer.target : null;
    const anchor = /** @type {HTMLAnchorElement | null} */ (target?.closest("a[href]") ?? null);
    // A page-link block is not editable text: clicking it goes to the page.
    const pageBlockId = anchor?.matches("a.page-link[data-page-id]") ? anchor.dataset.pageId : "";
    if (pageBlockId && element.contains(anchor)) {
      pointer.preventDefault();
      if (pageExists(hostWorkspace, pageBlockId)) options.navigate?.(pageBlockId);
      return;
    }
    const el = anchor ? editableFrom(anchor) : null;
    if (!anchor || !el || !element.contains(anchor)) return;
    pointer.preventDefault();
    if (pointer.metaKey || pointer.ctrlKey) {
      const href = anchor.getAttribute("href") ?? "";
      const linkedPage = pageIdOfLink(href);
      if (linkedPage) {
        if (pageExists(hostWorkspace, linkedPage)) options.navigate?.(linkedPage);
        return;
      }
      if (normalizeLinkUrl(href)) element.ownerDocument.defaultView?.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    // A drag or double-click that selects text is not a request for the card. (The
    // selection itself cannot tell: a click inside a selected link collapses it only after.)
    const down = lastPress;
    const dragged = down && Math.hypot(pointer.clientX - down.x, pointer.clientY - down.y) > 3;
    if (dragged || pointer.detail >= 2) return;
    openLinkCard(anchor, el);
  });

  element.addEventListener("mousemove", (event) => {
    const pointer = /** @type {MouseEvent} */ (event);
    if (!dragAnchor || !(pointer.buttons & 1) || !owns(/** @type {Node} */ (pointer.target))) return;
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
    if (!owns(/** @type {Node} */ (event.target))) return;
    const el = editableFrom(/** @type {Node} */ (event.target));
    if (linkCardOpen) {
      popovers.close();
      linkCardOpen = false;
    }
    if (el) {
      setActiveFromNode(el);
      commitEditable(el);
    }
  });

  element.addEventListener("paste", (event) => {
    if (!owns(/** @type {Node} */ (event.target))) return;
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
    if (!owns(/** @type {Node} */ (keyboard.target))) return;
    if (sel && keyboard.target === element) {
      handleSelectionKey(keyboard);
      return;
    }
    const el = editableFrom(/** @type {Node} */ (keyboard.target));
    if (!el) return;
    const mod = keyboard.metaKey || keyboard.ctrlKey;
    const key = keyOfEditable(el);
    const { start, end } = selectionOffsets(el);
    const length = modelLength(el);

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
    const child = activeChild();
    if (child) {
      child.setActiveType(spec);
      return;
    }
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
          dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { ordered: spec.ordered } });
          render();
        }
        return;
      }
      if (hit) {
        // Only the item under the caret changes type; the rest of the list stays a list.
        const newId = createId("block");
        const offset = activeEditable() ? caretOffset(/** @type {HTMLElement} */ (activeEditable())) : "end";
        dispatch("extractListItem", {
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
    dispatch("changeBlockType", { pageId, blockId: keep, type: spec.type, fields });
    render();
    if (spec.type === "list") focusBlock(keep, "end");
    else focusKey(keep, offset);
  }

  /** Nest the active unit (or each selected unit) one level deeper. */
  function indent() {
    const child = activeChild();
    if (child) {
      child.indent();
      return;
    }
    const el = activeEditable();
    if (el) handleTab(el, false);
  }

  /** Lift the active unit one level. */
  function outdent() {
    const child = activeChild();
    if (child) {
      child.outdent();
      return;
    }
    const el = activeEditable();
    if (el) handleTab(el, true);
  }

  /**
   * @param {{ type: string, [key: string]: unknown }} spec
   * @returns {string | null}
   */
  function insertAfterActive(spec) {
    const child = activeChild();
    if (child) return child.insertAfterActive(spec);
    if (!activeBlockId || !blockOf(activeBlockId)) return insertAtEnd(spec);
    return insertBlock(spec, { afterBlockId: activeBlockId });
  }

  /**
   * @param {{ type: string, [key: string]: unknown }} spec
   * @returns {string | null}
   */
  function insertAtEnd(spec) {
    const run = order();
    return insertBlock(spec, nested && run.length > 0 ? { afterBlockId: run[run.length - 1] } : { index: run.length });
  }

  /**
   * Whether a press on the editor's own box landed under the last block (the empty page
   * below the text) rather than in a gutter beside it.
   * @param {MouseEvent} pointer
   * @returns {boolean}
   */
  function clickedBelowLastBlock(pointer) {
    let last = element.lastElementChild;
    while (last && last === blockHandle) last = last.previousElementSibling;
    if (!last) return true;
    const rect = last.getBoundingClientRect();
    return rect.height <= 0 || pointer.clientY > rect.bottom;
  }

  /** Put the caret in a fresh trailing paragraph, reusing the last one if it is already empty. */
  function appendOrFocusTrailingParagraph() {
    const run = order();
    const lastId = run[run.length - 1];
    const last = lastId ? blockOf(lastId) : null;
    if (last && last.type === "paragraph" && (last.runs ?? []).every((r) => !r.ref && !r.text)) {
      focusBlock(lastId, "end");
      return;
    }
    insertAtEnd({ type: "paragraph" });
  }

  // -- context menu ------------------------------------------------------------

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
      item(getLinkInfo().inLink ? "Edit link…" : "Link…", "link", "ctx-link", () => openLinkEditor(), {
        disabled: !getLinkInfo().canLink
      }),
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
      item("Insert embed…", "link", "ctx-insert-embed", () => insertEmbed()),
      item("Insert expression…", "expression", "ctx-insert-expression", () => insertExpression()),
      ...(nested
        ? []
        : [
            item("Make section", "section", "ctx-make-section", () => makeSection(sel ? selectedTopLevel() : activeBlockId ? [topLevelOf(activeBlockId)] : []), {
              disabled: !info.blockId
            })
          ]),
      { separator: true },
      item(sel && selectedKeys().length > 1 ? "Delete blocks" : "Delete block", "trash", "ctx-delete", () => deleteActive(), {
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
    const units = [...element.querySelectorAll("[data-unit]")].filter(owns);
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
    if (!owns(/** @type {Node} */ (pointer.target))) return;
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

  // -- references: handle, menus, insertion ---------------------------------------

  /** @type {string | null} Top-level block the gutter handle is beside. */
  let handleTarget = null;
  let handleBusy = false;
  let justDragged = false;
  /** @type {HTMLElement | null} */
  const blockHandle = nested
    ? null
    : h("button", {
        class: "block-handle",
        type: "button",
        contenteditable: "false",
        "data-role": "block-handle",
        "aria-label": "Block options",
        title: "Click for options, drag to move"
      });
  blockHandle?.append(icon("grip", { size: 16 }));
  /** @type {HTMLElement | null} */
  let dropIndicator = null;

  /** @returns {HTMLElement[]} This editor's top-level block elements, in order. */
  function topLevelElements() {
    return /** @type {HTMLElement[]} */ ([...element.children].filter(
      (child) => child !== blockHandle && child !== dropIndicator && child.hasAttribute("data-block-id")
    ));
  }

  /** @param {string} blockId @returns {string} The top-level block that holds a block. */
  function topLevelOf(blockId) {
    let id = blockId;
    for (let guardCount = 0; guardCount < 50; guardCount++) {
      const parent = findContainer(content(), id)?.parent;
      if (!parent) return id;
      id = parent.blockId;
    }
    return id;
  }

  /** @param {string | null} blockId */
  function showHandleAt(blockId) {
    if (!blockHandle) return;
    const target = blockId ? topLevelElements().find((el) => el.getAttribute("data-block-id") === blockId) : null;
    if (!target) {
      if (!handleBusy) blockHandle.classList.remove("is-visible");
      return;
    }
    handleTarget = blockId;
    blockHandle.style.top = `${target.offsetTop}px`;
    blockHandle.classList.add("is-visible");
  }

  /** @returns {string[]} Top-level blocks covered by the unit selection, in order. */
  function selectedTopLevel() {
    const wanted = new Set(selectedKeys().map((key) => topLevelOf(parseKey(key).blockId)));
    return order().filter((id) => wanted.has(id));
  }

  /** @param {string} blockId @returns {string[]} The blocks a handle action on this block acts on. */
  function blocksFor(blockId) {
    const selected = selectedTopLevel();
    return selected.includes(blockId) ? selected : [blockId];
  }

  /** @returns {HTMLElement} Where follow-up popovers open from. */
  function anchorElement() {
    const target = handleTarget ? topLevelElements().find((el) => el.getAttribute("data-block-id") === handleTarget) : null;
    if (blockHandle?.classList.contains("is-visible")) return blockHandle;
    return target ?? element;
  }

  /** @param {string[]} ids Top-level blocks that become one section. */
  function makeSection(ids) {
    const top = order();
    const at = ids.map((id) => top.indexOf(id)).filter((index) => index >= 0);
    if (at.length === 0) return;
    const startBlockId = top[Math.min(...at)];
    const endBlockId = top[Math.max(...at)];
    promptName(popovers, anchorElement(), {
      title: "Section name",
      confirm: "Create",
      onSubmit: (name) => guard(() => hostWorkspace.dispatch("createSection", { pageId, locator: { startBlockId, endBlockId }, name }))
    });
  }

  /** Select the units of these top-level blocks, then delete them as one step. */
  function deleteBlocks(/** @type {string[]} */ ids) {
    const els = topLevelElements().filter((el) => ids.includes(el.getAttribute("data-block-id") ?? ""));
    if (els.length === 0) return;
    const units = (/** @type {HTMLElement} */ el) => [el, ...el.querySelectorAll("[data-unit]")].filter((u) => u.hasAttribute("data-unit") && owns(u));
    const first = units(els[0])[0];
    const lastUnits = units(els[els.length - 1]);
    const last = lastUnits[lastUnits.length - 1];
    if (!first || !last) return;
    setBlockSelection(first.getAttribute("data-unit") ?? "", last.getAttribute("data-unit") ?? "");
    deleteSelection();
  }

  /** Items for the gutter handle of one block. */
  function handleMenuItems(/** @type {string} */ blockId) {
    const block = blockOf(blockId);
    if (!block) return [];
    const anchor = () => anchorElement();
    /** @type {import("./popover.js").MenuItem[]} */
    const items = [];
    if (block.type === "sectionRef") {
      items.push(...referenceItems(block, anchor));
    } else {
      const ids = blocksFor(blockId);
      items.push({
        label: ids.length > 1 ? `Make section from ${ids.length} blocks` : "Make section",
        icon: "section",
        attrs: { "data-action": "section-make" },
        action: () => makeSection(ids)
      });
      const container = containerOf(hostWorkspace.data, pageId);
      for (const section of sectionsCovering(container, { blockId })) {
        if (!section.name) continue;
        items.push({
          label: `Section: ${section.name}`,
          icon: "section",
          attrs: { "data-action": "section-menu" },
          submenu: sectionMenuItems({
            workspace: /** @type {any} */ (hostWorkspace),
            popovers,
            anchor,
            sectionId: section.id,
            navigate: options.navigate
          })
        });
      }
    }
    items.push(
      { separator: true },
      {
        label: "Insert paragraph below",
        icon: "paragraph",
        attrs: { "data-action": "handle-insert-below" },
        action: () => void insertBlock({ type: "paragraph" }, { afterBlockId: blockId })
      },
      {
        label: blocksFor(blockId).length > 1 ? "Delete blocks" : "Delete block",
        icon: "trash",
        danger: true,
        attrs: { "data-action": "handle-delete" },
        action: () => deleteBlocks(blocksFor(blockId))
      }
    );
    return items;
  }

  /**
   * @param {any} record
   * @param {() => HTMLElement} anchor
   * @returns {import("./popover.js").MenuItem[]}
   */
  function referenceItems(record, anchor) {
    return referenceMenuItems({
      workspace: /** @type {any} */ (hostWorkspace),
      popovers,
      anchor,
      hostId: pageId,
      record,
      navigate: options.navigate,
      editExpression: () => editExpression(record, anchor()),
      replaceSource: () => replaceSource(record, anchor())
    });
  }

  /** @param {any} record @param {HTMLElement} anchor */
  function openReferenceMenu(record, anchor) {
    showMenu(popovers, anchor, referenceItems(record, () => anchor));
  }

  /** @param {any} record @param {HTMLElement} anchor */
  function editExpression(record, anchor) {
    openExpressionEditor({
      workspace: /** @type {any} */ (hostWorkspace),
      popovers,
      anchor,
      pageId,
      initial: record.expression ?? "",
      confirm: "Apply",
      onSubmit: (text) => guard(() => hostWorkspace.dispatch("setExpression", { pageId, instanceId: record.id, expression: text }))
    });
  }

  /** @param {any} record @param {HTMLElement} anchor */
  function replaceSource(record, anchor) {
    openReferencePicker({
      workspace: /** @type {any} */ (hostWorkspace),
      popovers,
      anchor,
      pageId,
      onPick: (item, name) =>
        guard(() =>
          hostWorkspace.transact("change reference", () => {
            const sectionId = ensureSection(/** @type {any} */ (hostWorkspace), item, name);
            hostWorkspace.dispatch("updateReference", { pageId, instanceId: record.id, patch: { sectionId } });
          })
        )
    });
  }

  /**
   * Where an inserted reference goes within the text, when the caret is in a non-empty
   * paragraph, heading, quote or list item: the reference joins that text at the caret.
   * @returns {Record<string, unknown> | null}
   */
  function inlinePosition() {
    const selection = element.ownerDocument.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    const editable = editableFrom(selection.getRangeAt(0).startContainer);
    if (!editable || !element.contains(editable) || !owns(editable)) return null;
    const blockId = editable.getAttribute("data-block-id");
    const block = blockId ? blockOf(blockId) : null;
    if (!block || !["paragraph", "heading", "quote", "list"].includes(block.type)) return null;
    const itemId = editable.getAttribute("data-item-id");
    if (block.type === "list" !== Boolean(itemId)) return null;
    const runs = runsOf(editable);
    if (isBlankRuns(runs)) return null;
    return { inline: { blockId, ...(itemId ? { itemId } : {}), offset: selectionOffsets(editable).start } };
  }

  /** @returns {Record<string, unknown>} Where an inserted reference block goes. */
  function insertionPosition() {
    const inline = inlinePosition();
    if (inline) return inline;
    if (activeBlockId && blockOf(activeBlockId)) return { afterBlockId: activeBlockId };
    const run = order();
    return nested && run.length > 0 ? { afterBlockId: run[run.length - 1] } : { index: run.length };
  }

  /**
   * Open the source picker and embed what is chosen after the active block.
   * @param {HTMLElement} [anchor]
   */
  function insertEmbed(anchor) {
    const child = activeChild();
    if (child) return child.insertEmbed(anchor);
    const position = insertionPosition();
    openReferencePicker({
      workspace: /** @type {any} */ (hostWorkspace),
      popovers,
      anchor: anchor ?? anchorElement(),
      pageId,
      onPick: (item, name) =>
        guard(() =>
          hostWorkspace.transact("insert reference", () => {
            const sectionId = ensureSection(/** @type {any} */ (hostWorkspace), item, name);
            hostWorkspace.dispatch("insertReference", { pageId, kind: "embed", sectionId, display: {}, ...position });
          })
        )
    });
  }

  /**
   * Open the expression editor and insert the result after the active block.
   * @param {HTMLElement} [anchor]
   */
  function insertExpression(anchor) {
    const child = activeChild();
    if (child) return child.insertExpression(anchor);
    const position = insertionPosition();
    openExpressionEditor({
      workspace: /** @type {any} */ (hostWorkspace),
      popovers,
      anchor: anchor ?? anchorElement(),
      pageId,
      initial: "",
      confirm: "Insert",
      onSubmit: (text) =>
        guard(() => hostWorkspace.dispatch("insertReference", { pageId, kind: "expression", expression: text, display: {}, ...position }))
    });
  }

  /** Copy a just-typed editable's content into every other copy of the same text. */
  function syncCopies() {
    const active = element.ownerDocument.activeElement;
    if (!active || !element.contains(active) || !isEditable(active)) return;
    const blockId = active.getAttribute("data-block-id");
    const itemId = active.getAttribute("data-item-id");
    if (!blockId) return;
    const selector = `[contenteditable="true"][data-block-id="${blockId}"]${itemId ? `[data-item-id="${itemId}"]` : ":not([data-item-id])"}`;
    for (const other of element.querySelectorAll(selector)) {
      if (other === active) continue;
      other.replaceChildren(...[...active.childNodes].map((node) => node.cloneNode(true)));
    }
  }

  if (blockHandle) {
    const doc = element.ownerDocument;
    /** @type {{ blockId: string, startY: number, active: boolean, target: string | null, side: "before" | "after" } | null} */
    let drag = null;

    /** @param {MouseEvent} event */
    const onDragMove = (event) => {
      if (!drag) return;
      if (!drag.active && Math.abs(event.clientY - drag.startY) < 4) return;
      drag.active = true;
      handleBusy = true;
      element.classList.add("is-block-dragging");
      const moving = new Set(blocksFor(drag.blockId));
      let best = null;
      let bestDistance = Infinity;
      for (const el of topLevelElements()) {
        if (moving.has(el.getAttribute("data-block-id") ?? "")) continue;
        const rect = el.getBoundingClientRect();
        const distance = event.clientY < rect.top ? rect.top - event.clientY : event.clientY > rect.bottom ? event.clientY - rect.bottom : 0;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { el, rect };
        }
      }
      if (!best) return;
      drag.target = best.el.getAttribute("data-block-id");
      drag.side = event.clientY < best.rect.top + best.rect.height / 2 ? "before" : "after";
      if (!dropIndicator) {
        dropIndicator = h("div", { class: "block-drop-indicator", "aria-hidden": "true" });
        element.append(dropIndicator);
      }
      dropIndicator.style.top = `${best.el.offsetTop + (drag.side === "after" ? best.el.offsetHeight : 0)}px`;
    };

    const onDragEnd = () => {
      doc.removeEventListener("mousemove", onDragMove);
      doc.removeEventListener("mouseup", onDragEnd);
      const finished = drag;
      drag = null;
      handleBusy = false;
      element.classList.remove("is-block-dragging");
      dropIndicator?.remove();
      dropIndicator = null;
      if (!finished?.active) return;
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
      if (!finished.target) return;
      const plan = planBlockMove(order(), blocksFor(finished.blockId), finished.target, finished.side);
      if (plan) guard(() => hostWorkspace.dispatch("moveBlocks", { pageId, ...plan }));
    };

    blockHandle.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !handleTarget) return;
      event.preventDefault();
      drag = { blockId: handleTarget, startY: event.clientY, active: false, target: null, side: "after" };
      doc.addEventListener("mousemove", onDragMove);
      doc.addEventListener("mouseup", onDragEnd);
    });

    blockHandle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (justDragged || !handleTarget) return;
      const items = handleMenuItems(handleTarget);
      handleBusy = true;
      showMenu(popovers, blockHandle, items);
      const release = () => {
        handleBusy = false;
        doc.removeEventListener("mousedown", release, true);
      };
      doc.addEventListener("mousedown", release, true);
    });

    element.addEventListener("mouseover", (event) => {
      if (handleBusy) return;
      let current = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
      while (current && current.parentElement !== element) current = current.parentElement;
      if (current && current !== blockHandle && current.hasAttribute("data-block-id")) {
        showHandleAt(current.getAttribute("data-block-id"));
      }
    });
    element.addEventListener("mouseleave", () => {
      if (handleBusy) return;
      showHandleAt(activeBlockId && blockOf(activeBlockId) ? topLevelOf(activeBlockId) : null);
    });
  }

  // Store subscription: skip re-render for inline-only commits so the caret stays.
  const unsubscribe = workspace.events.on("change", (event) => {
    const payload = /** @type {import("../workspace/changes.js").Change} */ (event);
    if (
      payload.kind === "commit" &&
      payload.origin === origin &&
      payload.commands.length > 0 &&
      payload.commands.every((command) => INLINE_COMMITS.has(command))
    ) {
      syncCopies();
      views.refreshExpressions();
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
    getLinkInfo,
    openLinkEditor,
    indent,
    outdent,
    getSelectedUnits: selectedKeys,
    clearSelection: clearBlockSelection,
    openContextMenu,
    insertEmbed,
    insertExpression,
    makeSection: () => makeSection(sel ? selectedTopLevel() : activeBlockId && blockOf(activeBlockId) ? [topLevelOf(activeBlockId)] : []),
    refreshExpressions: () => views.refreshExpressions(),
    destroy: () => {
      unsubscribe();
      views.destroy();
      popovers.destroy();
      element.ownerDocument.removeEventListener("mouseup", onMouseUp);
    }
  };
}
