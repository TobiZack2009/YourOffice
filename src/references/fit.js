/**
 * Where a reference sits relative to the text around it (pure).
 *
 * A reference placed inside a paragraph either flows with the text ("inline") or breaks
 * the paragraph, so what comes before it, the reference, and what follows it stack
 * (text / embed / text). The paragraph stays one block either way; only the drawing splits.
 *
 * The rule is structural, never a measurement of the text:
 *   - a scalar, an empty result or an error flows inline;
 *   - blocks flow inline only when they are a single paragraph, heading or quote
 *     (no list, code, image or nested structure, and only one block);
 *   - a table or slide flows inline only when it is drawn at most half as wide as the
 *     container, so it can sit beside text; several slides stack and always break.
 */

import { isHandle, isRange } from "../calc/values.js";
import { isFormulaError } from "../calc/errors.js";
import { findSection, sectionKind, sectionRunIds, sectionSlideIds } from "./sections.js";

/** A table or slide may flow inline up to this share of the container's width. */
export const INLINE_WIDTH_SHARE = 0.5;

const FLOWING_BLOCKS = new Set(["paragraph", "heading", "quote"]);

/**
 * @typedef {{ kind: "scalar" | "empty" | "error" | "table" } | { kind: "slide", count: number } | { kind: "blocks", count: number, flowing: boolean }} Shape
 */

/**
 * Shape of a section's content.
 * @param {import("./sections.js").FoundSection} found
 * @returns {Shape}
 */
export function shapeOfSection(found) {
  const kind = sectionKind(found);
  if (kind === "table") return { kind: "table" };
  if (kind === "slide") return { kind: "slide", count: sectionSlideIds(found.container.content, found.section.locator).length };
  const content = found.container.content;
  const ids = sectionRunIds(content, found.section.locator);
  const flowing =
    ids.length === 1 &&
    FLOWING_BLOCKS.has(content.blocks?.[ids[0]]?.type);
  return { kind: "blocks", count: ids.length, flowing };
}

/**
 * Shape of an expression's value.
 * @param {any} data Workspace data.
 * @param {any} value
 * @returns {Shape}
 */
export function shapeOfValue(data, value) {
  if (isFormulaError(value)) return { kind: "error" };
  if (value === null || value === undefined || value === "") return { kind: "empty" };
  if (isHandle(value)) {
    const found = findSection(data, value.sectionId);
    return found ? shapeOfSection(found) : { kind: "error" };
  }
  if (isRange(value)) return { kind: "table" };
  return { kind: "scalar" };
}

/**
 * @param {Shape} shape
 * @param {{ displayWidth?: number, containerWidth?: number }} [metrics] Pixels; unknown widths never flow.
 * @returns {"inline" | "break"}
 */
export function fitOf(shape, metrics = {}) {
  switch (shape.kind) {
    case "scalar":
    case "empty":
    case "error":
      return "inline";
    case "blocks":
      return shape.count === 1 && shape.flowing ? "inline" : "break";
    default: {
      // Several slides stack, so they always break the line.
      if (shape.kind === "slide" && shape.count > 1) return "break";
      const { displayWidth, containerWidth } = metrics;
      if (!(displayWidth > 0) || !(containerWidth > 0)) return "break";
      return displayWidth <= containerWidth * INLINE_WIDTH_SHARE ? "inline" : "break";
    }
  }
}
