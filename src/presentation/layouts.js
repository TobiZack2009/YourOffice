/**
 * Slide layouts: starting arrangements of text objects.
 *
 * A layout only pre-places objects; the slide keeps no link back to it (no
 * master or placeholder inheritance). Geometry is defined in fractions of the
 * slide size so new slides fit whatever size the presentation has.
 */

import { createObject } from "./model.js";

/** @typedef {import("./model.js").SlideObject} SlideObject */

/** Height the font sizes below are designed for; they scale with the slide height. */
const DESIGN_HEIGHT = 720;

/**
 * @param {{ width: number, height: number }} size
 * @param {{ name: string, fx: number, fy: number, fw: number, fh: number, fontSize: number, color?: string, align?: "left" | "center" | "right", valign?: "top" | "middle" | "bottom" }} spec
 * @returns {SlideObject}
 */
function textBox(size, spec) {
  return createObject("text", {
    name: spec.name,
    x: Math.round(spec.fx * size.width),
    y: Math.round(spec.fy * size.height),
    width: Math.round(spec.fw * size.width),
    height: Math.round(spec.fh * size.height),
    text: {
      runs: [],
      fontSize: Math.round(spec.fontSize * (size.height / DESIGN_HEIGHT)),
      color: spec.color ?? "#1d1d1f",
      align: spec.align ?? "left",
      valign: spec.valign ?? "top"
    }
  });
}

/**
 * @typedef {object} Layout
 * @property {string} id
 * @property {string} label
 * @property {(size: { width: number, height: number }) => SlideObject[]} objects
 */

/** @type {Layout[]} */
export const LAYOUTS = [
  {
    id: "title",
    label: "Title",
    objects: (size) => [
      textBox(size, { name: "Title", fx: 0.1, fy: 0.28, fw: 0.8, fh: 0.22, fontSize: 64, align: "center", valign: "bottom" }),
      textBox(size, { name: "Subtitle", fx: 0.15, fy: 0.54, fw: 0.7, fh: 0.12, fontSize: 30, color: "#6e6e73", align: "center" })
    ]
  },
  {
    id: "titleContent",
    label: "Title and content",
    objects: (size) => [
      textBox(size, { name: "Title", fx: 0.06, fy: 0.06, fw: 0.88, fh: 0.16, fontSize: 48, valign: "middle" }),
      textBox(size, { name: "Content", fx: 0.06, fy: 0.27, fw: 0.88, fh: 0.63, fontSize: 30 })
    ]
  },
  {
    id: "twoColumns",
    label: "Two columns",
    objects: (size) => [
      textBox(size, { name: "Title", fx: 0.06, fy: 0.06, fw: 0.88, fh: 0.16, fontSize: 48, valign: "middle" }),
      textBox(size, { name: "Left column", fx: 0.06, fy: 0.27, fw: 0.42, fh: 0.63, fontSize: 28 }),
      textBox(size, { name: "Right column", fx: 0.52, fy: 0.27, fw: 0.42, fh: 0.63, fontSize: 28 })
    ]
  },
  {
    id: "blank",
    label: "Blank",
    objects: () => []
  }
];

export const DEFAULT_LAYOUT = "titleContent";

/**
 * @param {string} id
 * @returns {Layout | undefined}
 */
export function getLayout(id) {
  return LAYOUTS.find((layout) => layout.id === id);
}
