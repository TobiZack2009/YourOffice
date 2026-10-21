/**
 * Slide renderer: a pure function from slide model to DOM.
 *
 * `renderSlide` returns an element of the presentation's *logical* size
 * (1280x720 by default) with objects absolutely positioned in logical pixels,
 * rotation via CSS transform and stacking from `objectOrder`. The stage draws it
 * scaled; thumbnails draw it smaller and non-interactive. Shapes and lines are
 * inline SVG; text goes through `renderRuns`, so content is only ever assigned
 * as text nodes (no HTML injection).
 */

import { isSafeUrl } from "../core/url.js";
import { renderRuns } from "../document/render.js";

/** @typedef {import("./model.js").Slide} Slide */
/** @typedef {import("./model.js").SlideObject} SlideObject */

const SVG_NS = "http://www.w3.org/2000/svg";

export const TEXT_PLACEHOLDER = "Click to add text";

/**
 * @typedef {object} RenderSlideOptions
 * @property {{ width: number, height: number }} [size] Logical slide size.
 * @property {Document} [document]
 * @property {number} [scale] CSS scale applied to the slide element (origin top-left).
 * @property {boolean} [interactive] Adds editing affordances (placeholders, line hit areas).
 * @property {(object: SlideObject) => HTMLElement | null} [renderReference] Draws the body of a
 *   `reference` object (an embed or expression); without it a plain placeholder is drawn.
 * @property {(ref: any) => HTMLElement | null} [renderInlineRef] Draws the body of an inline
 *   reference inside a text body.
 * @property {(assetId: string) => string | undefined} [resolveAssetUrl] The address an image asset is
 *   shown from; without it (or for an unknown asset) an image object draws nothing.
 */

/**
 * @param {RenderSlideOptions} [options]
 * @returns {Document}
 */
function getDocument(options) {
  const doc = options?.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) throw new Error("no DOM available; pass options.document");
  return doc;
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string | number>} attrs
 * @returns {SVGElement}
 */
function svgEl(doc, tag, attrs = {}) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return /** @type {SVGElement} */ (el);
}

/**
 * Render one slide.
 * @param {Slide} slide
 * @param {RenderSlideOptions} [options]
 * @returns {HTMLElement}
 */
export function renderSlide(slide, options = {}) {
  const doc = getDocument(options);
  const size = options.size ?? { width: 1280, height: 720 };
  const element = doc.createElement("div");
  element.className = "slide";
  element.dataset.slideId = slide.id;
  element.dataset.layout = slide.layout;
  element.style.width = `${size.width}px`;
  element.style.height = `${size.height}px`;
  element.style.background = slide.background?.color ?? "#ffffff";
  if (options.scale !== undefined && options.scale !== 1) {
    element.style.transform = `scale(${options.scale})`;
    element.style.transformOrigin = "0 0";
  }
  for (const id of slide.objectOrder) {
    const object = slide.objects[id];
    if (object) element.appendChild(renderObject(object, options));
  }
  return element;
}

/**
 * Render one object at its logical position.
 * @param {SlideObject} object
 * @param {RenderSlideOptions} [options]
 * @returns {HTMLElement}
 */
export function renderObject(object, options = {}) {
  const doc = getDocument(options);
  const interactive = options.interactive === true;
  const element = doc.createElement("div");
  element.className = `slide-object slide-object-${object.type}`;
  element.dataset.objectId = object.id;
  element.dataset.type = object.type;
  element.style.left = `${object.x}px`;
  element.style.top = `${object.y}px`;
  element.style.width = `${object.width}px`;
  element.style.height = `${object.height}px`;
  if (object.rotation) element.style.transform = `rotate(${object.rotation}deg)`;
  if (object.link) {
    element.dataset.linkKind = object.link.kind;
    if (object.link.kind === "url" && isSafeUrl(object.link.url)) element.dataset.href = object.link.url;
  }

  if (object.type === "shape") {
    element.appendChild(renderShapeSvg(doc, object));
    if (object.text) element.appendChild(renderTextBody(doc, object, interactive, options));
  } else if (object.type === "line") {
    element.appendChild(renderLineSvg(doc, object, interactive));
  } else if (object.type === "image") {
    const img = doc.createElement("img");
    img.className = "slide-image";
    img.setAttribute("alt", object.name ?? "");
    img.setAttribute("draggable", "false");
    const url = object.assetId ? options.resolveAssetUrl?.(object.assetId) : undefined;
    if (url) img.setAttribute("src", url);
    element.appendChild(img);
  } else if (object.type === "reference") {
    const body = options.renderReference?.(object) ?? doc.createElement("div");
    if (body.childNodes.length === 0) body.textContent = object.kind === "expression" ? "Expression" : "Reference";
    body.classList.add("slide-reference");
    body.dataset.role = "reference";
    element.appendChild(body);
  } else if (object.type === "text") {
    if (object.fill) element.style.background = object.fill;
    if (object.stroke) element.style.outline = `${object.stroke.width}px solid ${object.stroke.color}`;
    element.appendChild(renderTextBody(doc, object, interactive, options));
  }
  return element;
}

/**
 * @param {Document} doc
 * @param {SlideObject} object
 * @param {boolean} interactive
 * @param {RenderSlideOptions} [options]
 * @returns {HTMLElement}
 */
function renderTextBody(doc, object, interactive, options) {
  const body = object.text ?? { runs: [], fontSize: 32, color: "#1d1d1f", align: "left", valign: "top" };
  const element = doc.createElement("div");
  element.className = "slide-text";
  element.dataset.role = "text";
  element.style.fontSize = `${body.fontSize}px`;
  element.style.color = body.color;
  element.style.textAlign = body.align;
  element.style.justifyContent = { top: "flex-start", middle: "center", bottom: "flex-end" }[body.valign] ?? "flex-start";
  element.appendChild(renderRuns(body.runs, { document: doc, renderInlineRef: options?.renderInlineRef }));
  if (interactive && body.runs.length === 0 && object.type === "text") {
    element.dataset.placeholder = TEXT_PLACEHOLDER;
  }
  return element;
}

/**
 * @param {Document} doc
 * @param {SlideObject} object
 * @returns {SVGElement}
 */
function renderShapeSvg(doc, object) {
  const w = Math.max(object.width, 1);
  const h = Math.max(object.height, 1);
  const sw = object.stroke ? object.stroke.width : 0;
  const half = sw / 2;
  const svg = svgEl(doc, "svg", {
    class: "slide-svg",
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
    preserveAspectRatio: "none"
  });
  const paint = {
    fill: object.fill ?? "none",
    stroke: object.stroke ? object.stroke.color : "none",
    "stroke-width": sw,
    "stroke-linejoin": "round"
  };
  const iw = Math.max(w - sw, 0);
  const ih = Math.max(h - sw, 0);
  let shape;
  switch (object.shape) {
    case "ellipse":
      shape = svgEl(doc, "ellipse", { cx: w / 2, cy: h / 2, rx: iw / 2, ry: ih / 2, ...paint });
      break;
    case "roundRect": {
      const r = Math.min(iw, ih) * 0.18;
      shape = svgEl(doc, "rect", { x: half, y: half, width: iw, height: ih, rx: r, ry: r, ...paint });
      break;
    }
    case "triangle":
      shape = svgEl(doc, "polygon", { points: `${w / 2},${half} ${w - half},${h - half} ${half},${h - half}`, ...paint });
      break;
    case "arrow": {
      const neck = w * 0.6;
      const top = h * 0.25;
      const bottom = h * 0.75;
      const points = [
        [half, top], [neck, top], [neck, half], [w - half, h / 2],
        [neck, h - half], [neck, bottom], [half, bottom]
      ];
      shape = svgEl(doc, "polygon", { points: points.map((p) => p.join(",")).join(" "), ...paint });
      break;
    }
    default:
      shape = svgEl(doc, "rect", { x: half, y: half, width: iw, height: ih, ...paint });
  }
  svg.appendChild(shape);
  return svg;
}

/**
 * @param {Document} doc
 * @param {SlideObject} object
 * @param {boolean} interactive
 * @returns {SVGElement}
 */
function renderLineSvg(doc, object, interactive) {
  const w = object.width;
  const h = object.height;
  const stroke = object.stroke ?? { color: "#1d1d1f", width: 3 };
  const svg = svgEl(doc, "svg", {
    class: "slide-svg",
    viewBox: `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`,
    width: Math.max(w, 1),
    height: Math.max(h, 1),
    preserveAspectRatio: "none"
  });
  const [y1, y2] = object.flipV ? [h, 0] : [0, h];
  const coords = { x1: 0, y1, x2: w, y2 };
  if (interactive) {
    // A wide invisible stroke so thin lines are easy to hit.
    svg.appendChild(svgEl(doc, "line", { ...coords, class: "slide-line-hit", stroke: "transparent", "stroke-width": Math.max(stroke.width, 14) }));
  }
  svg.appendChild(svgEl(doc, "line", {
    ...coords,
    stroke: stroke.color,
    "stroke-width": stroke.width,
    "stroke-linecap": "round"
  }));
  return svg;
}
