/**
 * A slide as an SVG of a fixed size: the slide's own drawing placed in a `foreignObject`, so
 * text, tables and embedded content look exactly as in the app. Standalone SVG files carry the
 * stylesheet they need; an SVG placed in an HTML page leans on the page's.
 */

import { renderSlide } from "../presentation/render.js";
import { staticContext } from "./context.js";
import { svgDataUrl } from "./encode.js";
import { staticReferenceHooks } from "./static-render.js";
import { STANDALONE_SLIDE_CSS } from "./styles.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Characters XML cannot carry at all. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {string} containerId The presentation page.
 * @param {string} slideId
 * @param {{ standalone?: boolean }} [options] Standalone adds the stylesheet.
 * @returns {{ element: Element, width: number, height: number } | null} Null when the slide is gone.
 */
export function slideSvgElement(ctx, containerId, slideId, options = {}) {
  const doc = /** @type {Document} */ (ctx.document);
  const content = ctx.data.pages[containerId]?.content;
  const slide = content?.slides?.[slideId];
  if (!slide) return null;
  const size = content.size ?? { width: 1280, height: 720 };
  const sctx = staticContext(ctx);

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size.width));
  svg.setAttribute("height", String(size.height));
  svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  svg.setAttribute("class", "export-slide");
  svg.setAttribute("data-slide-id", slideId);
  if (options.standalone) {
    const style = doc.createElementNS(SVG_NS, "style");
    style.textContent = STANDALONE_SLIDE_CSS;
    svg.append(style);
  }
  const frame = doc.createElementNS(SVG_NS, "foreignObject");
  frame.setAttribute("x", "0");
  frame.setAttribute("y", "0");
  frame.setAttribute("width", String(size.width));
  frame.setAttribute("height", String(size.height));
  frame.append(renderSlide(slide, { size, document: doc, ...staticReferenceHooks(sctx, containerId, 0) }));
  svg.append(frame);
  return { element: svg, width: size.width, height: size.height };
}

/**
 * A slide as the text of a standalone SVG document.
 * @param {import("./context.js").ExportContext} ctx
 * @param {string} containerId
 * @param {string} slideId
 * @returns {string | null}
 */
export function slideSvgText(ctx, containerId, slideId) {
  const drawn = slideSvgElement(ctx, containerId, slideId, { standalone: true });
  if (!drawn) return null;
  const doc = /** @type {Document} */ (ctx.document);
  const Serializer = /** @type {any} */ (doc.defaultView)?.XMLSerializer ?? globalThis.XMLSerializer;
  const xml = new Serializer().serializeToString(drawn.element).replace(XML_INVALID, "");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}\n`;
}

/**
 * A slide as markup to place in an HTML page.
 * @param {import("./context.js").ExportContext} ctx
 * @param {string} containerId
 * @param {string} slideId
 * @returns {string | null}
 */
export function slideSvgInline(ctx, containerId, slideId) {
  const drawn = slideSvgElement(ctx, containerId, slideId);
  return drawn ? drawn.element.outerHTML.replace(XML_INVALID, "") : null;
}

/**
 * Let the context hand out slides as SVG `data:` addresses (drawn once each).
 * @param {import("./context.js").ExportContext} ctx
 */
export function provideSlideImages(ctx) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  ctx.slideImage = (containerId, slideId) => {
    const key = `${containerId}/${slideId}`;
    let url = cache.get(key);
    if (url === undefined) {
      const text = slideSvgText(ctx, containerId, slideId);
      url = text ? svgDataUrl(text) : "";
      cache.set(key, url);
    }
    return url;
  };
}
