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
import { entitiesOf } from "../workspace/changes.js";
import { pageContent, pageExists } from "../workspace/selectors.js";
import {
  canIndentBlock,
  canIndentItem,
  canOutdentBlock,
  readDocumentContent
} from "../document/model.js";
import { h } from "./dom.js";
import { defaultNotice } from "./notice.js";
import { createPopoverHost } from "./popover.js";
import { createReferenceViews } from "./reference-view.js";
import { normalizeText, parseInlineRuns, runsEqual } from "./inline.js";
import { createGestureScope } from "./gesture.js";
import { editableFrom, isEditable, placeCaret, selectionOffsets } from "./block-caret.js";
import { splitRunsAt } from "./block-runs.js";
import { createNestedStore } from "./nested-store.js";
import { createBlockSelectionOps } from "./block-selection-ops.js";
import { createBlockClipboard } from "./block-clipboard.js";
import { createUnitSelection } from "./block-unit-selection.js";
import { attachBlockEvents } from "./block-input.js";
import { createBlockToolbar } from "./block-toolbar.js";
import { createBlockSelectionIo } from "./block-selection-io.js";
import { createBlockView } from "./block-view.js";
import { createBlockStructure } from "./block-structure.js";
import { createBlockLinks } from "./block-links.js";
import { createBlockReferences } from "./block-references.js";
import { createBlockContextMenu } from "./block-context-menu.js";
import { createImageInsert } from "./block-image.js";
import { closestMark, unwrap, wrapRange } from "./block-marks.js";

export { splitRunsAt };

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../document/model.js").Block} Block */
/** @typedef {import("../document/model.js").InlineRun} InlineRun */
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
 *//** @typedef {ReturnType<typeof createDocumentEditor>} EditorHandle */

const MARK_TAG = { bold: "strong", italic: "em", underline: "u", strike: "s", code: "code" };
const EXEC_COMMAND = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };

/**
 * Create a document editor bound to one page, or (with `options.sectionId`) to one
 * section of a container, which is how an embed is edited in place.
 *
 * @param {Workspace} hostWorkspace
 * @param {string} pageId Page, or the container that holds the section.
 * @param {{
 *   resolvePageTitle?: (id: string) => string | undefined,
 *   resolveAssetUrl?: (assetId: string) => string | undefined,
 *   onActiveChange?: (info: ActiveInfo) => void,
 *   onChange?: () => void,
 *   sectionId?: string,
 *   origin?: string,
 *   navigate?: (pageId: string) => void,
 *   notice?: import("./notice.js").Notice
 * }} [options]
 */
export function createDocumentEditor(hostWorkspace, pageId, options = {}) {
  const notice = options.notice ?? defaultNotice;
  const guard = notice.guard;
  const nested = Boolean(options.sectionId);
  // One origin per editor tree: an embedded editor's typing is this editor's typing too.
  const origin = options.origin ?? createId("editor");
  const workspace = nested ? createNestedStore(hostWorkspace, /** @type {string} */ (options.sectionId)) : hostWorkspace;
  const element = h("div", {
    class: `document-editor${nested ? " is-embedded" : ""}`,
    role: "group",
    "aria-label": "Document body",
    tabindex: "-1",
    "data-history": "model"
  });

  /**
   * Dispatch as this editor, so its change events can be recognised as its own.
   * @param {string} type
   * @param {any} payload
   * @param {string} [coalesce]
   */
  const dispatch = (type, payload, coalesce) => workspace.dispatch(type, payload, { origin, coalesce });

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
    notice,
    workspace: hostWorkspace,
    hostId: pageId,
    resolvePageTitle: options.resolvePageTitle,
    resolveAssetUrl: options.resolveAssetUrl,
    createEditor: (sectionId, containerId) => {
      /** @type {any} */
      const child = createDocumentEditor(hostWorkspace, containerId, {
        sectionId,
        origin,
        notice,
        resolvePageTitle: options.resolvePageTitle,
        resolveAssetUrl: options.resolveAssetUrl,
        navigate: options.navigate,
        onActiveChange: () => {
          focusedChild = child;
          notifyActiveChange();
        }
      });
      return child;
    },
    onHandle: (record, anchor) => references.openReferenceMenu(record, anchor),
    onEditExpression: (record, frame) => references.editExpression(record, frame)
  });

  const renderOptions = {
    resolvePageTitle: options.resolvePageTitle,
    resolveAssetUrl: options.resolveAssetUrl,
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
    const raw = pageContent(workspace, pageId);
    return raw !== undefined || pageExists(workspace, pageId)
      ? readDocumentContent(raw, pageId)
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

  // -- rendering (block-view.js) -----------------------------------------------

  /** Draw the document; blocks whose data is unchanged keep their elements. */
  function render() {
    view.render();
  }

  /** @param {Set<string> | null} ids Touched entity ids, or null for every block. */
  function staleViews(ids) {
    view.staleViews(ids);
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
    // Typing in one block or list item is one undo step until the user pauses.
    const typing = `typing:${pageId}:${blockId}:${itemId ?? ""}`;

    if (block.type === "code") {
      const text = normalizeText(el.textContent ?? "");
      if (text !== (block.text ?? "")) {
        dispatch("updateBlock", { pageId, blockId, patch: { text } }, typing);
      }
      return;
    }

    const runs = parseInlineRuns(el);
    if (block.type === "list" && itemId) {
      const hit = locateItem(itemId);
      if (hit && !runsEqual(hit.item.runs ?? [], runs)) {
        const items = (hit.block.items ?? []).map((item) => (item.id === itemId ? { ...item, runs } : item));
        dispatch("updateBlock", { pageId, blockId: hit.block.id, patch: { items } }, typing);
      }
      return;
    }

    if (!runsEqual(block.runs ?? [], runs)) {
      dispatch("setBlockRuns", { pageId, blockId, runs }, typing);
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
    if (blockHandle && !references.isHandleBusy()) references.showHandleAt(blockId && blockOf(blockId) ? references.topLevelOf(blockId) : null);
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
    if (sel()) {
      unitSelection.drop();
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
  // The state lives in block-unit-selection.js.

  /** Document-level listeners of this editor's drags; aborted on destroy. */
  const gestures = createGestureScope(element.ownerDocument);
  const unitSelection = createUnitSelection({
    element,
    unitKeys,
    unitElement,
    editableOfUnit,
    parseKey,
    setActive,
    notifyActiveChange
  });
  const { selectedKeys, setBlockSelection, clearBlockSelection, selectAllUnits } = unitSelection;
  const applySelection = unitSelection.apply;
  const sel = () => unitSelection.get();

  // The operations live in block-selection-ops.js; these keep the names the rest of the editor uses.
  /** Delete what the selection covers as one undoable step; returns the caret left behind, if any. */
  function deleteSelection() {
    return selectionOps.deleteSelection();
  }
  /** @param {{ type: string, level?: number, ordered?: boolean }} spec */
  function applyTypeToSelection(spec) {
    selectionOps.applyTypeToSelection(spec);
  }
  /** @param {"bold" | "italic" | "underline" | "strike" | "code"} mark @returns {boolean} */
  function toggleMarkOnSelection(mark) {
    return selectionOps.toggleMarkOnSelection(mark);
  }
  /** @param {string} url @returns {boolean} */
  function setLinkOnSelection(url) {
    return selectionOps.setLinkOnSelection(url);
  }

  // -- structural edits --------------------------------------------------------


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

  // Enter, Backspace and Tab live in block-structure.js.
  /** @param {HTMLElement} el */
  function handleEnter(el) {
    structure.handleEnter(el);
  }
  /** @param {HTMLElement} el */
  function handleBackspace(el) {
    structure.handleBackspace(el);
  }
  /** @param {HTMLElement} el @param {boolean} shift @returns {boolean} */
  function handleTab(el, shift) {
    return structure.handleTab(el, shift);
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
    if (sel()) return toggleMarkOnSelection(mark);
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

  // -- links -------------------------------------------------------------------

  /** What the extracted controllers (links, ...) may use of this editor. */
  const ed = {
    element,
    hostWorkspace,
    options,
    popovers,
    sel,
    unitSelection,
    findEditable,
    focusBlock,
    applyTypeToSelection,
    setActiveFromNode,
    clickedBelowLastBlock,
    appendOrFocusTrailingParagraph,
    selectAllUnits,
    toggleMarkOnSelection,
    handleTab,
    handleEnter,
    handleBackspace,
    renderOptions,
    views,
    applySelection,
    insertAtEnd,
    resetHandle: () => references.resetHandle(),
    blockHandle: () => blockHandle,
    dropSelection: unitSelection.drop,
    workspace,
    dispatch,
    render,
    unitKeys,
    editableOfUnit,
    focusKey,
    keyOfBlock,
    gestures,
    guard,
    nested,
    pageId,
    content,
    order,
    owns,
    runsOf,
    insertBlock,
    setBlockSelection,
    deleteSelection,
    activeBlockId: () => activeBlockId,
    activeItemId: () => activeItemId,
    unitKey,
    unitElement,
    unitKeyFrom,
    clearBlockSelection,
    setActive,
    activeInfo,
    setActiveType,
    toggleMark,
    indent,
    outdent,
    insertAfterActive,
    insertTextInCode,
    keyOfEditable,
    neighborKey,
    activeChild,
    activeEditable,
    commitEditable,
    notifyActiveChange,
    selectedKeys,
    parseKey,
    blockOf,
    locateItem,
    setLinkOnSelection
  };
  const view = createBlockView(ed);
  const toolbar = createBlockToolbar(ed);
  const selectionOps = createBlockSelectionOps(ed);
  const clipboard = createBlockClipboard(ed, { selectionOps });
  const structure = createBlockStructure(ed);
  const links = createBlockLinks(ed);

  // -- active block info -------------------------------------------------------



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

  attachBlockEvents(ed, { links });
  clipboard.attach();

  // -- toolbar / external API --------------------------------------------------

  // The ribbon-facing commands live in block-toolbar.js.
  /** @param {{ type: string, level?: number, ordered?: boolean }} spec */
  function setActiveType(spec) {
    toolbar.setActiveType(spec);
  }
  /** Nest the active unit one level deeper. */
  function indent() {
    toolbar.indent();
  }
  /** Lift the active unit one level. */
  function outdent() {
    toolbar.outdent();
  }
  /** @param {{ type: string, [key: string]: unknown }} spec @returns {string | null} */
  function insertAfterActive(spec) {
    return toolbar.insertAfterActive(spec);
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

  // -- references and context menu ---------------------------------------------

  const references = createBlockReferences(ed);
  const blockHandle = references.blockHandle;
  const contextMenu = createBlockContextMenu(ed, { links, references, clipboard });

  // -- logical selection (block-selection-io.js) ------------------------------

  const selectionIo = createBlockSelectionIo(ed);
  const { captureSelection, restoreSelection } = selectionIo;

  // Store subscription: skip re-render for inline-only commits so the caret stays.
  const unsubscribe = workspace.events.on("change", (event) => {
    const payload = /** @type {import("../workspace/changes.js").Change} */ (event);
    // A change to a page this editor neither shows nor draws from is none of its business.
    if (payload.pages && !payload.pages.includes(pageId) && !views.drawsReferences()) return;
    if (
      payload.kind === "commit" &&
      payload.origin === origin &&
      payload.commands.length > 0 &&
      payload.commands.every((command) => workspace.commandMeta(command).inline)
    ) {
      // The DOM, not the model signature a block was drawn from, is the truth now: an undo that
      // brings the model back to that signature must still redraw the block.
      staleViews(entitiesOf(payload, pageId));
      references.syncCopies();
      views.refreshExpressions();
      options.onChange?.();
      return;
    }
    // Undo and redo rebuild the blocks under the caret: take the selection across.
    const carried = payload.kind === "commit" ? null : captureSelection();
    render();
    if (carried) restoreSelection(carried);
    const staleItem = activeItemId !== null && !locateItem(activeItemId);
    if ((activeBlockId && !blockOf(activeBlockId)) || staleItem) {
      activeBlockId = null;
      activeItemId = null;
      notifyActiveChange();
    }
    options.onChange?.();
  });

  render();

  const images = createImageInsert({ workspace: hostWorkspace, notice, insertAfterActive });

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
    setLink: (url, text) => links.setLink(url, text),
    getLinkInfo: () => links.getLinkInfo(),
    openLinkEditor: () => links.openLinkEditor(),
    indent,
    outdent,
    getSelectedUnits: selectedKeys,
    clearSelection: clearBlockSelection,
    openContextMenu: (point) => contextMenu.openContextMenu(point),
    insertImage: images.insert,
    insertImageFile: images.insertFile,
    pickImage: images.pick,
    insertEmbed: (anchor) => references.insertEmbed(anchor),
    insertExpression: (anchor) => references.insertExpression(anchor),
    makeSection: () => references.makeSection(sel() ? references.selectedTopLevel() : activeBlockId && blockOf(activeBlockId) ? [references.topLevelOf(activeBlockId)] : []),
    refreshExpressions: () => views.refreshExpressions(),
    captureSelection,
    restoreSelection,
    dependsOn: () => new Set([pageId]),
    focus: () => {
      const key = activeBlockId && blockOf(activeBlockId) ? keyOfBlock(activeBlockId) : unitKeys()[0];
      if (key) focusKey(key);
    },
    destroy: () => {
      unsubscribe();
      views.destroy();
      popovers.destroy();
      gestures.abort();
      unitSelection.destroy();
    }
  };
}
