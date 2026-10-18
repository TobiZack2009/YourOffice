/**
 * Read-only drawing of referenced content: a section's blocks, table or slide, and
 * the result of an expression. Used for previews in the picker and for everything an
 * expression shows; live (editable) embeds of text are built by `reference-view.js`
 * on top of the same pieces.
 *
 * Pure DOM output from workspace data: nothing here mutates the model.
 */

import { renderBlock } from "../document/render.js";
import { renderSlide } from "../presentation/render.js";
import { displayValue } from "../sheet/evaluator.js";
import { explain, isFormulaError } from "../sheet/errors.js";
import { isHandle, isRange, rangeDims } from "../sheet/values.js";
import { renderTable } from "../sheet/render.js";
import { TableEngines } from "../sheet/table-engine.js";
import { evaluateExpression } from "../references/expression.js";
import { findSection, locatorSlideIds, sectionKind, sectionRunIds, sectionSlideIds } from "../references/sections.js";
import { h } from "./dom.js";

const MAX_DEPTH = 6;
export const DEFAULT_SLIDE_WIDTH = 480;

/**
 * @typedef {object} StaticContext
 * @property {any} data Workspace data.
 * @property {import("../sheet/table-engine.js").TableEngines} [engines] Shared across a render pass.
 * @property {import("../sheet/recalc.js").RecalcEngine} [book] Shared across a render pass.
 * @property {(pageId: string) => string | undefined} [resolvePageTitle]
 * @property {number} [depth]
 */

/**
 * @param {any} data
 * @returns {TableEngines}
 */
export function enginesFor(data) {
  return new TableEngines(() => data);
}

/**
 * Hide everything outside a range (a range section shows only its cells).
 * @param {HTMLElement} wrapper A rendered `.sheet-table`.
 * @param {{ start: { col: number, row: number }, end: { col: number, row: number } }} range 0-based, inclusive.
 */
function clipToRange(wrapper, range) {
  const outsideCol = (/** @type {Element} */ el) => {
    const col = Number(el.getAttribute("data-col"));
    return col < range.start.col || col > range.end.col;
  };
  const outsideRow = (/** @type {Element} */ el) => {
    const row = Number(el.getAttribute("data-row"));
    return row < range.start.row || row > range.end.row;
  };
  for (const el of wrapper.querySelectorAll("col[data-col], th.sheet-col-header, td.sheet-cell")) {
    if (outsideCol(el)) /** @type {HTMLElement} */ (el).style.display = "none";
  }
  for (const el of wrapper.querySelectorAll("tr[data-row]")) {
    if (outsideRow(el)) /** @type {HTMLElement} */ (el).style.display = "none";
  }
  wrapper.querySelector(".sheet-table-name")?.remove();
}

/**
 * A table (or a range of one) drawn as a static grid.
 * @param {StaticContext} ctx
 * @param {any} found Result of `findSection`.
 * @returns {HTMLElement}
 */
export function renderTableSection(ctx, found) {
  const table = found.container.content.tables?.[found.section.locator.tableId];
  if (!table) return missing("The table is gone.");
  const engines = ctx.engines ?? enginesFor(ctx.data);
  const wrapper = renderTable(table, { engines, interactive: false });
  wrapper.classList.add("is-embedded");
  wrapper.style.left = "";
  wrapper.style.top = "";
  if (found.section.locator.range) clipToRange(wrapper, found.section.locator.range);
  return h("div", { class: "reference-table", "data-table-id": table.id }, [wrapper]);
}

/**
 * A slide drawn at a fixed width.
 * @param {StaticContext} ctx
 * @param {any} found
 * @param {number} [width] Display width in px.
 * @returns {HTMLElement}
 */
export function renderSlideSection(ctx, found, width = DEFAULT_SLIDE_WIDTH) {
  const content = found.container.content;
  const ids = sectionSlideIds(content, found.section.locator);
  if (ids.length === 0) return missing(locatorSlideIds(found.section.locator).length > 1 ? "The slides are gone." : "The slide is gone.");
  const size = content.size ?? { width: 1280, height: 720 };
  const scale = width / size.width;
  const depth = ctx.depth ?? 0;
  const drawn = ids.map((slideId) => {
    const slide = content.slides[slideId];
    const inner = renderSlide(slide, { size, scale, ...staticReferenceHooks(ctx, found.containerId, depth + 1) });
    return h(
      "div",
      {
        class: "reference-slide",
        "data-slide-id": slide.id,
        style: `width:${Math.round(width)}px;height:${Math.round(size.height * scale)}px`
      },
      [inner]
    );
  });
  // Several slides stack top to bottom, in the order of the presentation.
  return drawn.length === 1 ? drawn[0] : h("div", { class: "reference-slides" }, drawn);
}

/**
 * Hooks that let a slide draw its reference objects and inline references read-only.
 * @param {StaticContext} ctx
 * @param {string} containerId The page the slide lives in.
 * @param {number} depth
 * @returns {{ renderReference: (object: any) => HTMLElement, renderInlineRef: (ref: any) => HTMLElement }}
 */
export function staticReferenceHooks(ctx, containerId, depth) {
  return {
    renderReference: (object) => renderReferenceBlock(ctx, containerId, object, depth),
    renderInlineRef: (ref) => h("span", {}, [renderReferenceBlock(ctx, containerId, ref, depth)])
  };
}

/**
 * A section's blocks drawn read-only.
 * @param {StaticContext} ctx
 * @param {any} found
 * @returns {HTMLElement}
 */
export function renderBlocksSection(ctx, found) {
  const depth = ctx.depth ?? 0;
  const content = found.container.content;
  const wrap = h("div", { class: "reference-blocks" });
  const options = {
    resolvePageTitle: ctx.resolvePageTitle,
    blocks: content.blocks,
    renderReference: (/** @type {any} */ block) => renderReferenceBlock(ctx, found.containerId, block, depth + 1)
  };
  for (const id of sectionRunIds(content, found.section.locator)) {
    const block = content.blocks[id];
    const element = block ? renderBlock(block, options) : null;
    if (element) wrap.append(element);
  }
  return wrap;
}

/**
 * A reference block (embed or expression) drawn read-only, for use inside other
 * read-only content.
 * @param {StaticContext} ctx
 * @param {string} containerId Where the block lives.
 * @param {any} block
 * @param {number} depth
 * @returns {HTMLElement}
 */
export function renderReferenceBlock(ctx, containerId, block, depth) {
  if (depth > MAX_DEPTH) return missing("Too many levels of embedded content.");
  const inner = { ...ctx, depth };
  if (block.kind === "expression") {
    const result = evaluateExpression(ctx.data, containerId, block.expression ?? "", ctx.book ? { book: ctx.book } : {});
    return renderValue(inner, result.value);
  }
  return renderSectionById(inner, block.sectionId, block.display);
}

/**
 * Draw a section by id.
 * @param {StaticContext} ctx
 * @param {string | undefined} sectionId
 * @param {{ width?: number } | undefined} [display]
 * @returns {HTMLElement}
 */
export function renderSectionById(ctx, sectionId, display) {
  const found = sectionId ? findSection(ctx.data, sectionId) : null;
  if (!found) return missing("The source was removed.");
  const kind = sectionKind(found);
  if (kind === "table") return renderTableSection(ctx, found);
  if (kind === "slide") return renderSlideSection(ctx, found, display?.width);
  return renderBlocksSection(ctx, found);
}

/**
 * @param {string} message
 * @returns {HTMLElement}
 */
export function missing(message) {
  return h("div", { class: "reference-missing", text: message });
}

/**
 * A range value drawn as a plain grid.
 * @param {any[]} range
 * @returns {HTMLElement}
 */
function renderRange(range) {
  const { rows, cols } = rangeDims(range);
  const body = h("tbody");
  for (let r = 0; r < rows; r++) {
    const tr = h("tr");
    for (let c = 0; c < cols; c++) tr.append(h("td", { text: displayValue(range[r * cols + c] ?? null) }));
    body.append(tr);
  }
  return h("table", { class: "reference-range" }, [body]);
}

/**
 * An error as a chip that carries its explanation.
 * @param {any} error
 * @returns {HTMLElement}
 */
export function renderErrorChip(error) {
  const info = explain(error);
  return h("span", {
    class: "reference-chip is-error",
    title: info.text,
    "aria-label": `${info.code}: ${info.text}`,
    "data-error": info.code,
    "data-explanation": info.text,
    text: info.code
  });
}

/**
 * What an expression's value looks like.
 * @param {StaticContext} ctx
 * @param {any} value
 * @returns {HTMLElement}
 */
export function renderValue(ctx, value) {
  if (isFormulaError(value)) return renderErrorChip(value);
  if (value === null || value === undefined || value === "") return h("span", { class: "reference-empty" });
  if (isHandle(value)) return renderSectionById({ ...ctx, depth: (ctx.depth ?? 0) + 1 }, value.sectionId);
  if (isRange(value)) return renderRange(value);
  return h("span", { class: "reference-chip", text: displayValue(value) });
}
