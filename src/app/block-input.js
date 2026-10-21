/**
 * DOM events on the document editor: focus, pointer presses and drags that select units,
 * link clicks, typing, paste and the keys that act on text or on selected units. Each handler
 * translates the event into calls on the editor; none of them changes the model itself.
 * State shared with the editor arrives through the `ed` kernel.
 */

import { editableFrom, selectionOffsets } from "./block-caret.js";
import { modelLength } from "./inline.js";
import { normalizeLinkUrl, pageIdOfLink } from "./link-form.js";
import { pageExists } from "../workspace/selectors.js";

/**
 * @param {any} ed Editor kernel (see `createDocumentEditor`).
 * @param {{ links: ReturnType<typeof import("./block-links.js").createBlockLinks> }} parts
 */
export function attachBlockEvents(ed, parts) {
  const { links } = parts;
  const { element, hostWorkspace, options, gestures, nested, owns } = ed;
  const { setActiveFromNode, clickedBelowLastBlock, clearBlockSelection, appendOrFocusTrailingParagraph, unitKeyFrom, unitKey, unitElement } = ed;
  const { setBlockSelection, commitEditable, insertTextInCode, deleteSelection, focusKey, neighborKey, selectAllUnits } = ed;
  const { toggleMarkOnSelection, keyOfEditable, toggleMark, handleTab, handleEnter, handleBackspace } = ed;

  /** @type {string | null} Unit where the current mouse drag began. */
  let dragAnchor = null;

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
      if (ed.sel()) clearBlockSelection();
      appendOrFocusTrailingParagraph();
      return;
    }
    lastPress = { x: pointer.clientX, y: pointer.clientY };
    const key = unitKeyFrom(/** @type {Node} */ (pointer.target));
    if (ed.sel()) clearBlockSelection();

    // Shift-click in another unit selects everything in between.
    const activeKey = ed.activeBlockId() ? unitKey(ed.activeBlockId(), ed.activeItemId()) : null;
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
    links.openLinkCard(anchor, el);
  });

  element.addEventListener("mousemove", (event) => {
    const pointer = /** @type {MouseEvent} */ (event);
    if (!dragAnchor || !(pointer.buttons & 1) || !owns(/** @type {Node} */ (pointer.target))) return;
    const key = unitKeyFrom(/** @type {Node} */ (pointer.target));
    if (!key) return;
    if (!ed.sel() && key === dragAnchor) return;
    setBlockSelection(dragAnchor, key);
  });

  const onMouseUp = () => {
    dragAnchor = null;
  };
  gestures.listen("mouseup", onMouseUp);

  element.addEventListener("input", (event) => {
    if (!owns(/** @type {Node} */ (event.target))) return;
    const el = editableFrom(/** @type {Node} */ (event.target));
    links.dismissCard();
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
    if (!ed.sel()) return;
    const mod = keyboard.metaKey || keyboard.ctrlKey;
    const key = keyboard.key;

    if (key === "Backspace" || key === "Delete") {
      keyboard.preventDefault();
      deleteSelection();
    } else if (key === "Escape" || key === "Enter") {
      keyboard.preventDefault();
      const target = ed.sel().focus;
      focusKey(target, "end");
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      keyboard.preventDefault();
      const next = neighborKey(ed.sel().focus, key === "ArrowUp" ? -1 : 1, false);
      if (keyboard.shiftKey) {
        if (next) setBlockSelection(ed.sel().anchor, next);
      } else {
        const to = next ?? ed.sel().focus;
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
    if (ed.sel() && keyboard.target === element) {
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
}
