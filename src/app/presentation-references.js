/**
 * Reference objects on slides: the handle of a selected one, its menu, and placing embeds and expressions (inline in text being edited, or as their own object).
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { caretOffset } from "./inline.js";
import { createId } from "../core/ids.js";
import { ensureSection } from "../references/catalog.js";
import { findSection, sectionKind } from "../references/sections.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { openExpressionEditor } from "./expression-editor.js";
import { openReferencePicker } from "./reference-picker.js";
import { referenceMenuItems, showMenu as showAnchoredMenu } from "./handles.js";
import { REFERENCE_BOXES, runsFromHost } from "./presentation-dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../presentation/model.js").SlideObject} SlideObject */
/** @typedef {import("../presentation/model.js").Slide} Slide */
/** @typedef {import("../presentation/model.js").Animation} Animation */
/** @typedef {import("../presentation/model.js").PresentationContent} PresentationContent */
/** @typedef {import("./marks.js").Mark} Mark */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** @param {any} ed Editor kernel (see `createPresentationEditor`). */
export function createPresentationReferences(ed) {
  const { finishEdit, getSize, getSlide, notice, options, pageId, popovers, run, send, st, stageArea, workspace } = ed;

  /**
   * The handle of a selected reference object: opens its menu.
   * @param {SlideObject} object
   * @returns {HTMLElement}
   */
  function referenceHandle(object) {
    const button = h("button", {
      class: "slide-reference-handle",
      type: "button",
      "data-role": "reference-handle",
      "aria-label": object.kind === "expression" ? "Expression" : "Embedded content",
      title: object.kind === "expression" ? "Expression" : "Embedded content"
    }, [icon(object.kind === "expression" ? "expression" : "link", { size: 14 })]);
    button.style.left = `${object.x + object.width}px`;
    button.style.top = `${object.y}px`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      showAnchoredMenu(popovers, button, referenceItems(object, () => button));
    });
    return button;
  }

  /**
   * @param {SlideObject} object
   * @param {() => HTMLElement} anchor
   */
  function referenceItems(object, anchor) {
    return referenceMenuItems({
      guard: notice.guard,
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor,
      hostId: pageId,
      record: object,
      navigate: options.navigate,
      editExpression: () => editExpression(object, anchor()),
      replaceSource: () => replaceSource(object, anchor())
    });
  }

  /** @param {SlideObject} object @param {HTMLElement} anchor */
  function editExpression(object, anchor) {
    openExpressionEditor({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor,
      pageId,
      initial: object.expression ?? "",
      confirm: "Apply",
      onSubmit: (text) => run(() => send("setExpression", { instanceId: object.id, expression: text }))
    });
  }

  /** Swap which section a reference object shows. @param {SlideObject} object @param {HTMLElement} anchor */
  function replaceSource(object, anchor) {
    openReferencePicker({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor,
      pageId,
      onPick: (item, name) =>
        run(() =>
          workspace.transact("change reference", () => {
            const sectionId = ensureSection(/** @type {any} */ (workspace), item, name);
            send("updateReference", { instanceId: object.id, patch: { sectionId } });
          })
        )
    });
  }

  /**
   * Where a new reference goes: into the text being edited at the caret, or as its own object.
   * Committing the edit first keeps the caret offset in step with the stored text.
   * @returns {{ inline: { slideId: string, objectId: string, offset: number } } | null}
   */
  function inlinePlacement() {
    if (!st.editing || !st.currentSlideId) return null;
    const { id, host } = st.editing;
    const blank = runsFromHost(host).every((r) => !r.ref && r.text.trim() === "");
    if (blank) return null;
    const offset = caretOffset(host);
    finishEdit(true);
    return { inline: { slideId: st.currentSlideId, objectId: id, offset } };
  }

  /**
   * Place a reference: inline when text is being edited, else a standalone object, centred.
   * @param {Record<string, unknown>} fields `kind` plus `sectionId` or `expression`.
   * @param {ReturnType<typeof inlinePlacement>} inlineAt
   * @param {{ width: number, height: number }} box
   */
  function placeReference(fields, inlineAt, box) {
    if (!st.currentSlideId) return;
    if (inlineAt) {
      const { objectId } = inlineAt.inline;
      workspace.transact("insert reference", () => {
        send("insertReference", { slideId: st.currentSlideId, display: {}, ...fields, ...inlineAt });
        if (getSlide()?.objects[objectId]?.type === "text") {
          send("updateObject", { slideId: st.currentSlideId, objectId, patch: { autoHeight: true } });
        }
      });
      return;
    }
    const size = getSize();
    const width = Math.min(box.width, size.width);
    const height = Math.min(box.height, size.height);
    const instanceId = createId("obj");
    st.selectedIds = [instanceId];
    st.tool = null;
    send("insertReference", {
      slideId: st.currentSlideId,
      display: {},
      ...fields,
      instanceId,
      x: Math.round((size.width - width) / 2),
      y: Math.round((size.height - height) / 2),
      width,
      height
    });
  }

  /**
   * Open the source picker and embed what is chosen.
   * @param {HTMLElement} [anchor]
   */
  function insertEmbed(anchor) {
    if (!st.currentSlideId) return;
    const inlineAt = inlinePlacement();
    openReferencePicker({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor: anchor ?? stageArea,
      pageId,
      onPick: (item, name) =>
        run(() =>
          workspace.transact("insert reference", () => {
            const sectionId = ensureSection(/** @type {any} */ (workspace), item, name);
            const kind = sectionKind(findSection(workspace.data, sectionId));
            placeReference({ kind: "embed", sectionId }, inlineAt, REFERENCE_BOXES[kind] ?? REFERENCE_BOXES.blocks);
          })
        )
    });
  }

  /**
   * Open the expression editor and place its result.
   * @param {HTMLElement} [anchor]
   */
  function insertExpression(anchor) {
    if (!st.currentSlideId) return;
    const inlineAt = inlinePlacement();
    openExpressionEditor({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor: anchor ?? stageArea,
      pageId,
      initial: "",
      confirm: "Insert",
      onSubmit: (text) => run(() => placeReference({ kind: "expression", expression: text }, inlineAt, REFERENCE_BOXES.expression))
    });
  }

  return { referenceHandle, referenceItems, editExpression, replaceSource, inlinePlacement, placeReference, insertEmbed, insertExpression };
}
