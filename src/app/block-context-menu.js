/**
 * The document editor's context menu: clipboard, marks, turn-into, indent, insertion and
 * delete for the unit under the pointer. State shared with the editor arrives through the
 * `ed` kernel; `parts` carries the sibling controllers it opens.
 */

import { icon } from "./icons.js";
import { buildMenu } from "./popover.js";

/**
 * @param {any} ed Editor kernel (see `createDocumentEditor`).
 * @param {{ links: ReturnType<typeof import("./block-links.js").createBlockLinks>, references: ReturnType<typeof import("./block-references.js").createBlockReferences>, clipboard: ReturnType<typeof import("./block-clipboard.js").createBlockClipboard> }} parts
 */
export function createBlockContextMenu(ed, parts) {
  const { links, references, clipboard } = parts;
  const { element, popovers, nested, owns, blockOf, unitKey, unitElement, unitKeyFrom, parseKey, selectedKeys } = ed;
  const { setBlockSelection, clearBlockSelection, deleteSelection, setActive, activeEditable, activeInfo } = ed;
  const { insertTextInCode, setActiveType, toggleMark, indent, outdent, insertAfterActive } = ed;

  /** Delete the selected units, or the unit under the caret. */
  function deleteActive() {
    if (!ed.sel()) {
      if (!ed.activeBlockId() || !blockOf(ed.activeBlockId())) return;
      const key = unitKey(ed.activeBlockId(), ed.activeItemId());
      setBlockSelection(key, key);
    }
    deleteSelection();
  }

  /** @returns {boolean} Whether text (or whole blocks) are selected for formatting. */
  function hasTextSelection() {
    if (ed.sel()) return true;
    const selection = element.ownerDocument.getSelection?.();
    return Boolean(selection && selection.rangeCount > 0 && !selection.getRangeAt(0).collapsed);
  }

  /** Paste plain text from the system clipboard at the caret or over the selection. */
  async function pasteFromClipboard() {
    const text = await element.ownerDocument.defaultView?.navigator?.clipboard?.readText?.();
    if (!text) return;
    const el = activeEditable();
    if (el?.matches("code[data-block-id]") && !ed.sel()) {
      el.focus();
      insertTextInCode(el, text.replace(/\r\n?/g, "\n"));
      return;
    }
    clipboard.pasteText(text);
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
      item("Cut", "cut", "ctx-cut", () => clipboard.cutSelection(), { disabled: !hasTextSelection() }),
      item("Copy", "copy", "ctx-copy", () => clipboard.copySelection(), { disabled: !hasTextSelection() }),
      item("Paste", "paste", "ctx-paste", () => void pasteFromClipboard(), { disabled: !info.blockId && !ed.sel() }),
      { separator: true },
      markItem("Bold", "bold"),
      markItem("Italic", "italic"),
      markItem("Underline", "underline"),
      markItem("Strikethrough", "strike"),
      markItem("Inline code", "code"),
      item(links.getLinkInfo().inLink ? "Edit link…" : "Link…", "link", "ctx-link", () => links.openLinkEditor(), {
        disabled: !links.getLinkInfo().canLink
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
      item("Insert embed…", "link", "ctx-insert-embed", () => references.insertEmbed()),
      item("Insert expression…", "expression", "ctx-insert-expression", () => references.insertExpression()),
      ...(nested
        ? []
        : [
            item("Make section", "section", "ctx-make-section", () => references.makeSection(ed.sel() ? references.selectedTopLevel() : ed.activeBlockId() ? [references.topLevelOf(ed.activeBlockId())] : []), {
              disabled: !info.blockId
            })
          ]),
      { separator: true },
      item(ed.sel() && selectedKeys().length > 1 ? "Delete blocks" : "Delete block", "trash", "ctx-delete", () => deleteActive(), {
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
    if (ed.activeBlockId() && blockOf(ed.activeBlockId())) {
      const active = unitKey(ed.activeBlockId(), ed.activeItemId());
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
    if (!(ed.sel() && selectedKeys().includes(key))) {
      if (ed.sel()) clearBlockSelection();
      const { blockId, itemId } = parseKey(key);
      if (blockId !== ed.activeBlockId() || itemId !== ed.activeItemId()) setActive(blockId, itemId);
    }
    openContextMenu({ x: pointer.clientX, y: pointer.clientY });
  });

  return { openContextMenu };
}
