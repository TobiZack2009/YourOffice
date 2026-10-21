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
 * The host editor owns this cache. Every reference is keyed by its record id: its frame
 * element is kept between renders and patched in place (state classes, handle, body). A nested
 * editor is kept too, and is rebuilt only when the block now points somewhere else. A static
 * body (table, slide, expression value) is drawn fresh each pass but swapped in only when it
 * differs from what is shown (`isEqualNode`), so an unchanged reference keeps its nodes.
 * `begin` / `render` / `end` bracket one host render.
 */

import { renderRuns } from "../document/render.js";
import { evaluateExpression } from "../references/expression.js";
import { fitOf, shapeOfSection, shapeOfValue } from "../references/fit.js";
import { findSection, sectionKind, sectionRunIds } from "../references/sections.js";
import { HEADER_WIDTH, columnWidthOf } from "../calc/model.js";
import { isHandle } from "../calc/values.js";
import { buildBook } from "../references/table-engine.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { defaultNotice } from "./notice.js";
import {
  DEFAULT_SLIDE_WIDTH,
  enginesFor,
  missing,
  renderSectionById,
  renderSlideSection,
  renderTableSection,
  renderValue
} from "../export/static-render.js";

/**
 * @typedef {object} ReferenceViewsOptions
 * @property {{ data: any }} workspace
 * @property {string} hostId Container the host document lives in.
 * @property {(sectionId: string, containerId: string, instanceId: string) => any} createEditor
 *   Builds a nested document editor over a section.
 * @property {(record: any, anchor: HTMLElement) => void} onHandle The handle was pressed.
 * @property {(record: any, frame: HTMLElement) => void} [onEditExpression] Double-click on an expression result.
 * @property {(pageId: string) => string | undefined} [resolvePageTitle]
 * @property {(assetId: string) => string | undefined} [resolveAssetUrl]
 * @property {import("./notice.js").Notice} [notice] Where messages go (the default host when absent).
 */

/**
 * @typedef {object} Frame One drawn reference: its element, handle and body.
 * @property {"embed" | "expression" | "inline"} kind
 * @property {any} record The current record (the block or run reference); it changes under the frame.
 * @property {HTMLElement} el
 * @property {HTMLElement} body
 * @property {HTMLElement} handle
 * @property {"link" | "function" | "removed" | null} look
 */

/**
 * @param {ReferenceViewsOptions} options
 */
export function createReferenceViews(options) {
  const notice = options.notice ?? defaultNotice;
  /** @type {Map<string, { signature: string, editor: any }>} */
  const views = new Map();
  /** @type {Set<string>} */
  let used = new Set();
  /** @type {Map<string, () => void>} Expression bodies that can be refreshed in place. */
  const updaters = new Map();
  /** @type {Map<string, Frame>} Drawn reference frames by record id. */
  const frames = new Map();
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

  /** @returns {import("../export/static-render.js").StaticContext} */
  function context() {
    const { engines, book } = shared();
    return { data: options.workspace.data, engines, book, resolvePageTitle: options.resolvePageTitle, resolveAssetUrl: options.resolveAssetUrl };
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
    for (const id of frames.keys()) if (!used.has(id)) frames.delete(id);
    pass = null;
  }

  /**
   * The cached frame of a record, or a new one. A record id drawn twice in one pass (a copy)
   * gets its own uncached frame so the first keeps its element.
   * @param {any} record
   * @param {Frame["kind"]} kind
   * @param {() => Frame} build
   * @returns {Frame}
   */
  function acquire(record, kind, build) {
    const duplicate = used.has(record.id);
    used.add(record.id);
    let frame = duplicate ? undefined : frames.get(record.id);
    if (frame && frame.kind !== kind) {
      frames.delete(record.id);
      frame = undefined;
    }
    if (!frame) {
      frame = build();
      if (!duplicate) frames.set(record.id, frame);
    }
    frame.record = record;
    return frame;
  }

  /**
   * Show `fresh` in `body` unless an equal node is already there.
   * @param {HTMLElement} body
   * @param {Node} fresh
   */
  function show(body, fresh) {
    const current = body.firstChild;
    if (current === fresh && body.childNodes.length === 1) return;
    if (current && body.childNodes.length === 1 && current.isEqualNode(fresh)) return;
    body.replaceChildren(fresh);
  }

  /**
   * The handle button of a frame. It reads the frame's current record when pressed.
   * @param {Frame} frame
   * @returns {HTMLElement}
   */
  function handleButton(frame) {
    const button = h("button", {
      class: "reference-handle",
      type: "button",
      contenteditable: "false",
      "data-role": "reference-handle"
    });
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onHandle(frame.record, button);
    });
    return button;
  }

  /**
   * @param {Frame} frame
   * @param {"link" | "function" | "removed"} look
   */
  function setLook(frame, look) {
    if (frame.look === look) return;
    frame.look = look;
    const name = look === "function" ? "expression" : look === "removed" ? "unlink" : "link";
    const label =
      look === "function" ? "Expression options" : look === "removed" ? "Source removed: reference options" : "Reference options";
    frame.handle.setAttribute("aria-label", label);
    frame.handle.setAttribute("title", label);
    frame.handle.replaceChildren(icon(name, { size: 14 }));
  }

  /**
   * A frame with a handle and a body.
   * @param {Frame["kind"]} kind
   * @param {any} record
   * @param {string} tag
   * @param {Record<string, string>} props
   * @returns {Frame}
   */
  function buildFrame(kind, record, tag, props) {
    const outer = h(tag, props);
    const body = h(tag, { class: "reference-body" });
    /** @type {Frame} */
    const frame = { kind, record, el: outer, body, handle: /** @type {any} */ (null), look: null };
    frame.handle = handleButton(frame);
    outer.append(frame.handle, body);
    return frame;
  }

  /**
   * Draw one reference block.
   * @param {any} record The `sectionRef` block.
   * @returns {HTMLElement}
   */
  function render(record) {
    return record.kind === "expression" ? renderExpression(record) : renderEmbed(record);
  }

  /**
   * @param {any} record
   * @returns {HTMLElement}
   */
  function renderEmbed(record) {
    const data = options.workspace.data;
    const frame = acquire(record, "embed", () =>
      buildFrame("embed", record, "div", {
        class: "reference is-embed",
        contenteditable: "false",
        "data-reference-id": record.id,
        "data-kind": "embed"
      })
    );
    const found = record.sectionId ? findSection(data, record.sectionId) : null;
    const state = !found ? "missing" : found.detached ? "removed" : "live";
    for (const name of ["live", "missing", "removed"]) frame.el.classList.toggle(`is-${name}`, name === state);
    frame.el.setAttribute("data-state", state);
    setLook(frame, state === "live" ? "link" : "removed");

    if (!found) {
      frame.el.removeAttribute("data-section-kind");
      show(frame.body, missing("The source was removed."));
      return frame.el;
    }
    const kind = sectionKind(found);
    frame.el.setAttribute("data-section-kind", kind);
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
      show(frame.body, view.editor.element);
    } else if (kind === "table") {
      show(frame.body, renderTableSection(context(), found));
    } else {
      show(frame.body, renderSlideSection(context(), found, record.display?.width));
    }
    return frame.el;
  }

  /**
   * @param {any} record
   * @returns {HTMLElement}
   */
  function renderExpression(record) {
    const frame = acquire(record, "expression", () => {
      const built = buildFrame("expression", record, "div", {
        class: "reference is-expression",
        contenteditable: "false",
        "data-reference-id": record.id,
        "data-kind": "expression"
      });
      built.el.addEventListener("dblclick", (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest(".reference-handle")) return;
        options.onEditExpression?.(built.record, built.el);
      });
      return built;
    });
    setLook(frame, "function");
    const fill = () => {
      const result = evaluateExpression(options.workspace.data, options.hostId, frame.record.expression ?? "", {
        book: shared().book
      });
      frame.el.setAttribute("data-result", result.type);
      const shown = renderValue(context(), result.value);
      if (shown.classList.contains("is-error")) {
        shown.addEventListener("click", () => notice.show(shown.getAttribute("data-explanation") ?? "", { kind: "info" }));
      }
      show(frame.body, shown);
    };
    fill();
    updaters.set(record.id, fill);
    return frame.el;
  }

  /**
   * Drawn width in px of what a section shows, for the inline fit rule.
   * @param {any} found
   * @param {{ width?: number } | undefined} display
   * @returns {number}
   */
  function displayWidthOf(found, display) {
    const kind = sectionKind(found);
    if (kind === "slide") return display?.width ?? DEFAULT_SLIDE_WIDTH;
    if (kind !== "table") return 0;
    const table = found.container.content.tables?.[found.section.locator.tableId];
    if (!table) return 0;
    const range = found.section.locator.range;
    const first = range ? range.start.col : 0;
    const last = range ? range.end.col : table.columnCount - 1;
    let width = range ? 0 : HEADER_WIDTH;
    for (let col = first; col <= last; col++) width += columnWidthOf(table, col);
    return width;
  }

  /**
   * The single paragraph/heading/quote of a section as flowing text.
   * @param {any} found
   * @returns {HTMLElement}
   */
  function inlineText(found) {
    const content = found.container.content;
    const [id] = sectionRunIds(content, found.section.locator);
    const block = content.blocks?.[id];
    return h("span", { class: "inline-ref-text" }, [
      renderRuns(block?.runs ?? [], { resolvePageTitle: options.resolvePageTitle })
    ]);
  }

  /**
   * Draw one inline reference. It flows with the text when its shape allows it
   * (`data-fit="inline"`), otherwise it breaks the paragraph (`data-fit="break"`); the
   * paragraph stays a single block either way. Inline references are read-only here.
   * @param {any} record The reference carried by the run.
   * @param {number} [containerWidth] Width of the paragraph in px; 0 when unknown.
   * @returns {HTMLElement}
   */
  function renderInline(record, containerWidth = 0) {
    const data = options.workspace.data;
    const frame = acquire(record, "inline", () => {
      const built = buildFrame("inline", record, "span", {
        class: `reference is-${record.kind}`,
        "data-kind": record.kind
      });
      if (record.kind === "expression") {
        built.el.addEventListener("dblclick", (event) => {
          if (/** @type {HTMLElement} */ (event.target).closest(".reference-handle")) return;
          options.onEditExpression?.(built.record, built.el);
        });
      }
      return built;
    });
    const outer = frame.el;
    const body = frame.body;

    const fill = () => {
      /** @type {any} */
      let found = null;
      let shape;
      let state = "live";
      /** @type {any} */
      let result = null;
      if (record.kind === "expression") {
        result = evaluateExpression(data, options.hostId, record.expression ?? "", { book: shared().book });
        shape = shapeOfValue(data, result.value);
        if (isHandle(result.value)) found = findSection(data, result.value.sectionId);
      } else {
        found = record.sectionId ? findSection(data, record.sectionId) : null;
        state = !found ? "missing" : found.detached ? "removed" : "live";
        shape = found ? shapeOfSection(found) : { kind: "error" };
      }
      const fit = fitOf(shape, {
        displayWidth: found ? displayWidthOf(found, record.display) : 0,
        containerWidth
      });
      outer.setAttribute("data-fit", fit);
      outer.setAttribute("data-state", state);
      outer.setAttribute("data-shape", shape.kind);
      outer.classList.toggle("is-removed", state === "removed");
      setLook(frame, state === "removed" ? "removed" : record.kind === "expression" ? "function" : "link");

      /** @type {HTMLElement} */
      let shown;
      if (record.kind === "expression" && !found) {
        shown = renderValue(context(), result.value);
        if (shown.classList.contains("is-error")) {
          const chip = shown;
          chip.addEventListener("click", () => notice.show(chip.getAttribute("data-explanation") ?? "", { kind: "info" }));
        }
      } else if (!found) {
        shown = missing("The source was removed.");
      } else if (fit === "inline" && shape.kind === "blocks") {
        shown = inlineText(found);
      } else if (record.kind === "expression") {
        shown = renderValue(context(), result.value);
      } else {
        shown = renderSectionById(context(), record.sectionId, record.display);
      }
      show(body, shown);
    };
    fill();
    updaters.set(record.id, fill);
    return outer;
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
    renderInline,
    refreshExpressions,
    /** @returns {boolean} Whether the last render drew an embed or an expression (content of other pages). */
    drawsReferences: () => used.size > 0 || updaters.size > 0,
    /** @returns {any[]} Nested editors currently alive. */
    childEditors: () => [...views.values()].map((view) => view.editor),
    destroy() {
      for (const view of views.values()) view.editor.destroy();
      views.clear();
      frames.clear();
      updaters.clear();
    },
    renderSectionById: (/** @type {string} */ sectionId) => renderSectionById(context(), sectionId)
  };
}
