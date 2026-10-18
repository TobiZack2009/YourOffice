/**
 * Live reference frames inside a document editor.
 *
 * A `sectionRef` block is drawn as a frame: a small handle (link icon for an embed,
 * function icon for an expression, unlink when the source was removed) and a body.
 *   - embed of text    a nested document editor over the section's blocks (editable)
 *   - embed of table   the table drawn static, clipped to the section's range
 *   - embed of slide   the slide drawn static at the display width
 *   - expression       the value, read-only (scalar chip, blocks, grid, slide, error chip)
 *
 * The host editor owns this cache. A nested editor is kept between renders, so a
 * re-render of the host does not lose it; it is rebuilt only when the block now
 * points somewhere else. `begin` / `render` / `end` bracket one host render.
 */

import { evaluateExpression } from "../references/expression.js";
import { findSection, sectionKind } from "../references/sections.js";
import { buildBook } from "../sheet/table-engine.js";
import { clear, h } from "./dom.js";
import { icon } from "./icons.js";
import { showNotice } from "./notice.js";
import {
  enginesFor,
  missing,
  renderSectionById,
  renderSlideSection,
  renderTableSection,
  renderValue
} from "./reference-render.js";

/**
 * @typedef {object} ReferenceViewsOptions
 * @property {{ data: any }} workspace
 * @property {string} hostId Container the host document lives in.
 * @property {(sectionId: string, containerId: string, instanceId: string) => any} createEditor
 *   Builds a nested document editor over a section.
 * @property {(record: any, anchor: HTMLElement) => void} onHandle The handle was pressed.
 * @property {(record: any, frame: HTMLElement) => void} [onEditExpression] Double-click on an expression result.
 * @property {(pageId: string) => string | undefined} [resolvePageTitle]
 */

/**
 * @param {ReferenceViewsOptions} options
 */
export function createReferenceViews(options) {
  /** @type {Map<string, { signature: string, editor: any }>} */
  const views = new Map();
  /** @type {Set<string>} */
  let used = new Set();
  /** @type {Map<string, () => void>} Expression bodies that can be refreshed in place. */
  const updaters = new Map();
  /** @type {{ engines: any, book: any } | null} */
  let pass = null;

  /** One engine per render pass, built on first use. */
  function shared() {
    if (!pass) {
      const data = options.workspace.data;
      pass = { engines: enginesFor(data), book: buildBook(data) };
    }
    return pass;
  }

  /** @returns {import("./reference-render.js").StaticContext} */
  function context() {
    const { engines, book } = shared();
    return { data: options.workspace.data, engines, book, resolvePageTitle: options.resolvePageTitle };
  }

  function begin() {
    used = new Set();
    updaters.clear();
    pass = null;
  }

  function end() {
    for (const [id, view] of views) {
      if (used.has(id)) continue;
      view.editor.destroy();
      views.delete(id);
    }
    pass = null;
  }

  /**
   * @param {any} record
   * @param {"link" | "function" | "removed"} look
   * @returns {HTMLElement}
   */
  function handleButton(record, look) {
    const name = look === "function" ? "expression" : look === "removed" ? "unlink" : "link";
    const label =
      look === "function" ? "Expression options" : look === "removed" ? "Source removed: reference options" : "Reference options";
    const button = h("button", {
      class: "reference-handle",
      type: "button",
      contenteditable: "false",
      "data-role": "reference-handle",
      "aria-label": label,
      title: label
    });
    button.append(icon(name, { size: 14 }));
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onHandle(record, button);
    });
    return button;
  }

  /**
   * Draw one reference block.
   * @param {any} record The `sectionRef` block.
   * @returns {HTMLElement}
   */
  function render(record) {
    used.add(record.id);
    return record.kind === "expression" ? renderExpression(record) : renderEmbed(record);
  }

  /**
   * @param {any} record
   * @returns {HTMLElement}
   */
  function renderEmbed(record) {
    const data = options.workspace.data;
    const found = record.sectionId ? findSection(data, record.sectionId) : null;
    const state = !found ? "missing" : found.detached ? "removed" : "live";
    const frame = h("div", {
      class: `reference is-embed is-${state}`,
      contenteditable: "false",
      "data-reference-id": record.id,
      "data-kind": "embed",
      "data-state": state
    });
    const body = h("div", { class: "reference-body" });
    frame.append(handleButton(record, state === "live" ? "link" : "removed"), body);

    if (!found) {
      body.append(missing("The source was removed."));
      return frame;
    }
    const kind = sectionKind(found);
    frame.setAttribute("data-section-kind", kind);
    if (kind === "blocks") {
      const signature = `${record.sectionId}|${found.containerId}`;
      let view = views.get(record.id);
      if (view && view.signature !== signature) {
        view.editor.destroy();
        views.delete(record.id);
        view = undefined;
      }
      if (!view) {
        view = { signature, editor: options.createEditor(record.sectionId, found.containerId, record.id) };
        views.set(record.id, view);
      } else {
        view.editor.refresh();
      }
      body.append(view.editor.element);
    } else if (kind === "table") {
      body.append(renderTableSection(context(), found));
    } else {
      body.append(renderSlideSection(context(), found, record.display?.width));
    }
    return frame;
  }

  /**
   * @param {any} record
   * @returns {HTMLElement}
   */
  function renderExpression(record) {
    const frame = h("div", {
      class: "reference is-expression",
      contenteditable: "false",
      "data-reference-id": record.id,
      "data-kind": "expression"
    });
    const body = h("div", { class: "reference-body" });
    frame.append(handleButton(record, "function"), body);
    const fill = () => {
      clear(body);
      const result = evaluateExpression(options.workspace.data, options.hostId, record.expression ?? "", {
        book: shared().book
      });
      frame.setAttribute("data-result", result.type);
      const shown = renderValue(context(), result.value);
      if (shown.classList.contains("is-error")) {
        shown.addEventListener("click", () => showNotice(shown.getAttribute("data-explanation") ?? "", { kind: "info" }));
      }
      body.append(shown);
    };
    fill();
    updaters.set(record.id, fill);
    frame.addEventListener("dblclick", (event) => {
      if (/** @type {HTMLElement} */ (event.target).closest(".reference-handle")) return;
      options.onEditExpression?.(record, frame);
    });
    return frame;
  }

  /** Recompute every expression drawn by this cache, and those of nested editors. */
  function refreshExpressions() {
    pass = null;
    for (const update of updaters.values()) update();
    for (const view of views.values()) view.editor.refreshExpressions?.();
  }

  return {
    begin,
    end,
    render,
    refreshExpressions,
    /** @returns {any[]} Nested editors currently alive. */
    childEditors: () => [...views.values()].map((view) => view.editor),
    destroy() {
      for (const view of views.values()) view.editor.destroy();
      views.clear();
      updaters.clear();
    },
    renderSectionById: (/** @type {string} */ sectionId) => renderSectionById(context(), sectionId)
  };
}
