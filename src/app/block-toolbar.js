/**
 * Ribbon-facing commands of the document editor: change the type of the active block (or of
 * the selected units), nest or lift it, insert beside it. A caret inside an embedded editor
 * sends the call there instead. State shared with the editor arrives through the `ed` kernel.
 */

import { createId } from "../core/ids.js";
import { caretOffset } from "./inline.js";

/** @param {any} ed Editor kernel (see `createDocumentEditor`). */
export function createBlockToolbar(ed) {
  const { pageId, dispatch, render, blockOf, locateItem, activeChild, activeEditable } = ed;
  const { applyTypeToSelection, focusBlock, focusKey, handleTab, insertAtEnd, insertBlock } = ed;

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
    if (ed.sel()) {
      applyTypeToSelection(spec);
      return;
    }
    if (!ed.activeBlockId() || !blockOf(ed.activeBlockId())) {
      insertAtEnd(spec);
      return;
    }
    const active = blockOf(ed.activeBlockId());
    if (active?.type === "list" && ed.activeItemId()) {
      const hit = locateItem(ed.activeItemId());
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
    const keep = ed.activeBlockId();
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
    if (!ed.activeBlockId() || !blockOf(ed.activeBlockId())) return insertAtEnd(spec);
    return insertBlock(spec, { afterBlockId: ed.activeBlockId() });
  }

  return { setActiveType, indent, outdent, insertAfterActive };
}
