/**
 * Gutter handle, block drag, section and reference menus, and reference insertion for the
 * document editor. State shared with the editor arrives through the `ed` kernel.
 */

import { ensureSection } from "../references/catalog.js";
import { findContainer } from "../document/model.js";
import { containerOf } from "../references/containers.js";
import { sectionsCovering } from "../references/sections.js";
import { h } from "./dom.js";
import { planBlockMove, promptName, referenceMenuItems, sectionMenuItems, showMenu } from "./handles.js";
import { icon } from "./icons.js";
import { openExpressionEditor } from "./expression-editor.js";
import { openReferencePicker } from "./reference-picker.js";
import { editableFrom, isEditable, selectionOffsets } from "./block-caret.js";
import { isBlankRuns } from "./block-runs.js";

/** @param {any} ed Editor kernel (see `createDocumentEditor`). */
export function createBlockReferences(ed) {
  const { element, hostWorkspace, options, popovers, gestures, guard, nested, pageId } = ed;
  const { content, order, blockOf, owns, runsOf, insertBlock, setBlockSelection, deleteSelection, selectedKeys, parseKey, activeChild } = ed;

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
            navigate: options.navigate,
            guard
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
      guard,
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
    if (ed.activeBlockId() && blockOf(ed.activeBlockId())) return { afterBlockId: ed.activeBlockId() };
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

    /** @type {Array<() => void>} */
    let dragStops = [];
    const stopDragListeners = () => {
      for (const stop of dragStops) stop();
      dragStops = [];
    };

    const onDragEnd = () => {
      stopDragListeners();
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
      stopDragListeners();
      dragStops = [gestures.listen("mousemove", onDragMove), gestures.listen("mouseup", onDragEnd)];
    });

    blockHandle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (justDragged || !handleTarget) return;
      const items = handleMenuItems(handleTarget);
      handleBusy = true;
      showMenu(popovers, blockHandle, items);
      const stopRelease = gestures.listen(
        "mousedown",
        () => {
          handleBusy = false;
          stopRelease();
        },
        true
      );
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
      showHandleAt(ed.activeBlockId() && blockOf(ed.activeBlockId()) ? topLevelOf(ed.activeBlockId()) : null);
    });
  }

  return {
    blockHandle,
    /** Forget which block the handle sits beside (the block elements were redrawn). */
    resetHandle() {
      handleTarget = null;
    },
    isHandleBusy: () => handleBusy,
    showHandleAt,
    topLevelOf,
    selectedTopLevel,
    makeSection,
    openReferenceMenu,
    editExpression,
    insertEmbed,
    insertExpression,
    syncCopies
  };
}
