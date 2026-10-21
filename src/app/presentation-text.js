/**
 * In-place text editing on a slide: start and finish an edit, marks, links and the text state the ribbon reads.
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { buildLinkForm, linkPages, pageIdOfLink, pageLinkUrl } from "./link-form.js";
import { createTextBody } from "../presentation/model.js";
import { markStateIn, setLinkIn, toggleMarkIn } from "./marks.js";
import { renderObject } from "../presentation/render.js";
import { runsEqual } from "./inline.js";
import { closest, insertLineBreak, insertTextAtCaret, runsFromHost, textCapable } from "./presentation-dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../presentation/model.js").SlideObject} SlideObject */
/** @typedef {import("../presentation/model.js").Slide} Slide */
/** @typedef {import("../presentation/model.js").Animation} Animation */
/** @typedef {import("../presentation/model.js").PresentationContent} PresentationContent */
/** @typedef {import("./marks.js").Mark} Mark */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** @param {any} ed Editor kernel (see `createPresentationEditor`). */
export function createPresentationText(ed) {
  const { afterStateChange, getSelectedObjects, getSlide, objectEls, pageId, popovers, renderStage, run, send, setObjectLink, slideHooks, st, stageArea, workspace } = ed;

  /** @returns {string | null} Id of the single selected object that can carry text. */
  function editableId() {
    const objects = getSelectedObjects();
    return objects.length === 1 && textCapable(objects[0]) ? objects[0].id : null;
  }

  const isEditing = () => st.editing !== null;

  /**
   * @param {string | null} [id]
   * @returns {boolean}
   */
  function startEdit(id = editableId()) {
    if (st.editing) return true;
    const slide = getSlide();
    const object = id ? slide?.objects[id] : null;
    if (!object || !textCapable(object)) return false;
    popovers.close();
    if (!(st.selectedIds.length === 1 && st.selectedIds[0] === object.id)) st.selectedIds = [object.id];
    st.tool = null;

    const shown = { ...object, text: object.text ?? createTextBody({ align: "center", valign: "middle" }) };
    const fresh = renderObject(shown, { interactive: true, ...slideHooks() });
    objectEls.get(object.id)?.replaceWith(fresh);
    objectEls.set(object.id, fresh);
    const host = /** @type {HTMLElement} */ (fresh.querySelector(".slide-text"));
    host.setAttribute("contenteditable", "true");
    host.setAttribute("tabindex", "-1");
    host.setAttribute("data-history", "model");
    host.setAttribute("spellcheck", "false");
    host.dataset.editing = "true";
    st.editing = { id: object.id, host, original: structuredClone(object.text?.runs ?? []), lastRange: null };

    host.addEventListener("keydown", (event) => onHostKeydown(/** @type {KeyboardEvent} */ (event)));
    host.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = /** @type {ClipboardEvent} */ (event).clipboardData?.getData("text/plain") ?? "";
      if (text) insertTextAtCaret(host, text);
    });
    host.addEventListener("blur", (event) => {
      if (!st.editing || st.editing.host !== host || st.suppressBlur) return;
      const next = /** @type {FocusEvent} */ (event).relatedTarget;
      if (closest(next, ".popover")) return;
      finishEdit(true);
    });

    host.focus();
    const selection = document.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(host);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    afterStateChange();
    return true;
  }

  /** @param {KeyboardEvent} event */
  function onHostKeydown(event) {
    if (!st.editing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const host = st.editing.host;
    // Typing belongs to the text: keep it away from stage shortcuts and the shell's workspace undo.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      finishEdit(false, { refocus: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (mod) finishEdit(true, { refocus: true });
      else insertLineBreak(host);
    } else if (event.key === "Tab") {
      event.preventDefault();
    } else if (mod && (key === "b" || key === "i" || key === "u")) {
      event.preventDefault();
      toggleMark(/** @type {Mark} */ ({ b: "bold", i: "italic", u: "underline" }[key]));
    }
  }

  function onSelectionChange() {
    if (!st.editing) return;
    const selection = document.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (st.editing.host.contains(range.commonAncestorContainer)) st.editing.lastRange = range.cloneRange();
  }

  /**
   * Leave in-place editing.
   * @param {boolean} commit Save the text through `setObjectRuns` when it changed.
   * @param {{ refocus?: boolean }} [opts]
   * @returns {boolean} true when a command was dispatched
   */
  function finishEdit(commit, opts = {}) {
    if (!st.editing) return false;
    const { id, host, original } = st.editing;
    st.editing = null;
    let dispatched = false;
    if (commit && st.currentSlideId) {
      const runs = runsFromHost(host);
      if (!runsEqual(runs, original)) {
        dispatched = run(() => send("setObjectRuns", { slideId: st.currentSlideId, objectId: id, runs }));
      }
    }
    if (!dispatched) {
      renderStage();
      afterStateChange();
    }
    if (opts.refocus) stageArea.focus();
    return dispatched;
  }

  /** @param {Mark} mark */
  function toggleMark(mark) {
    if (st.editing) {
      restoreRange();
      toggleMarkIn(st.editing.host, mark);
      return;
    }
    const targets = getSelectedObjects().filter((o) => textCapable(o) && o.text && o.text.runs.length > 0);
    if (targets.length === 0 || !st.currentSlideId) return;
    const allOn = targets.every((o) => (o.text?.runs ?? []).every((r) => r.marks?.[mark]));
    workspace.transact(`toggle ${mark}`, () => {
      for (const object of targets) {
        const runs = (object.text?.runs ?? []).map((r) => {
          const marks = { ...(r.marks ?? {}) };
          if (allOn) delete marks[mark];
          else marks[mark] = true;
          return Object.keys(marks).length > 0 ? { text: r.text, marks } : { text: r.text };
        });
        send("setObjectRuns", { slideId: st.currentSlideId, objectId: object.id, runs });
      }
    });
  }

  /** @param {Mark} mark */
  function markActive(mark) {
    if (st.editing) return markStateIn(st.editing.host, mark);
    const targets = getSelectedObjects().filter((o) => textCapable(o) && o.text && o.text.runs.length > 0);
    return targets.length > 0 && targets.every((o) => (o.text?.runs ?? []).every((r) => r.marks?.[mark]));
  }

  function restoreRange() {
    if (!st.editing?.lastRange) return;
    const selection = document.getSelection?.();
    if (!selection) return;
    const current = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (current && st.editing.host.contains(current.commonAncestorContainer)) return;
    selection.removeAllRanges();
    selection.addRange(st.editing.lastRange);
  }

  /**
   * While editing: link the selected text. Otherwise: link the whole object.
   * An empty url removes the link.
   * @param {string} url
   * @returns {boolean}
   */
  function setLink(url) {
    if (st.editing) {
      restoreRange();
      return setLinkIn(st.editing.host, url);
    }
    if (getSelectedObjects().length === 0) return false;
    const pageId = pageIdOfLink(url);
    setObjectLink(!url ? null : pageId ? { kind: "page", pageId } : { kind: "url", url });
    return true;
  }

  /** The link under the caret/selection (editing) or on the selected object. */
  function getLinkUrl() {
    if (st.editing) {
      const range = st.editing.lastRange;
      const anchor = range ? closest(range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement, "a") : null;
      return anchor?.getAttribute("href") ?? "";
    }
    const link = getSelectedObjects()[0]?.link;
    if (link?.kind === "page") return pageLinkUrl(link.pageId);
    return link?.kind === "url" ? link.url : "";
  }

  /**
   * What the link form needs: the address (a page is `#<pageId>`) and whether something is
   * linked. A slide link counts as linked even though it has no address here.
   * @returns {import("./link-form.js").LinkInfo}
   */
  function getLinkInfo() {
    const url = getLinkUrl();
    const slideLink = !st.editing && getSelectedObjects()[0]?.link?.kind === "slide";
    const canLink = st.editing ? true : getSelectedObjects().length > 0;
    return { canLink, inLink: url !== "" || slideLink, url, text: "", hasSelection: true, wholeBlocks: true };
  }

  /**
   * The link form (web address or page) for the ribbon and the context menu. Applying links
   * the selected text while editing, otherwise the selected objects.
   * @param {() => void} close
   * @returns {HTMLElement}
   */
  function createLinkForm(close) {
    const form = buildLinkForm({
      info: getLinkInfo(),
      pages: linkPages(workspace),
      onApply: ({ url }) => setLink(url),
      onRemove: () => setLink(""),
      close
    });
    // Keep typing in the form from reaching the editor's shortcuts.
    form.addEventListener("keydown", (event) => event.stopPropagation());
    return form;
  }

  const canEditText = () => getSelectedObjects().some(textCapable);

  function getTextState() {
    return getSelectedObjects().find(textCapable)?.text ?? null;
  }

  document.addEventListener("selectionchange", onSelectionChange);

  return { editableId, isEditing, startEdit, onHostKeydown, onSelectionChange, finishEdit, toggleMark, markActive, restoreRange, setLink, getLinkUrl, getLinkInfo, createLinkForm, canEditText, getTextState, dispose: () => document.removeEventListener("selectionchange", onSelectionChange) };
}
