/**
 * Inline SVG icons for the ribbon and sidebar.
 *
 * Every icon is a 24x24 outline drawn with `currentColor`, so it follows the
 * surrounding text colour (and the per-page-type accent). Elements are built with
 * `createElementNS`; no markup strings are ever parsed.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Icon definitions: SVG path data (`d`), or a `text` glyph for letter icons.
 * @type {Record<string, { paths?: string[], text?: string, style?: string }>}
 */
const ICONS = {
  // text styles
  paragraph: { paths: ["M13 4v16", "M17 4v16", "M17 4H9.5a4.5 4.5 0 0 0 0 9H13"] },
  h1: { text: "H1" },
  h2: { text: "H2" },
  h3: { text: "H3" },
  bold: { text: "B", style: "bold" },
  italic: { text: "I", style: "italic" },
  underline: { text: "U", style: "underline" },
  strike: { text: "S", style: "strike" },
  code: { paths: ["m9 8-4 4 4 4", "m15 8 4 4-4 4"] },
  "code-block": { paths: ["M4 5h16v14H4z", "m9.5 10-2 2 2 2", "m14.5 10 2 2-2 2"] },
  link: {
    paths: [
      "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1",
      "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"
    ]
  },
  list: { paths: ["M9 6h11", "M9 12h11", "M9 18h11", "M4.5 6h.01", "M4.5 12h.01", "M4.5 18h.01"] },
  quote: {
    paths: [
      "M5 17v-4a5 5 0 0 1 4-5",
      "M5 13h4v4H5z",
      "M14 17v-4a5 5 0 0 1 4-5",
      "M14 13h4v4h-4z"
    ]
  },
  divider: { paths: ["M4 12h16", "M8 6h8", "M8 18h8"] },
  indent: { paths: ["M4 5h16", "M12 10h8", "M12 15h8", "M4 20h16", "m4 9 3 3-3 3"] },
  outdent: { paths: ["M4 5h16", "M12 10h8", "M12 15h8", "M4 20h16", "m7 9-3 3 3 3"] },
  "page-link": { paths: ["M7 3h8l4 4v14H7z", "M15 3v4h4", "M10 14h6", "M13 11l3 3-3 3"] },

  // embeds / sheet / slide objects
  sheet: { paths: ["M4 5h16v14H4z", "M4 10h16", "M4 15h16", "M10 5v14"] },
  slide: { paths: ["M3 5h18v12H3z", "M8 21h8", "M12 17v4"] },
  table: { paths: ["M4 5h16v14H4z", "M4 10h16", "M10 5v14"] },
  "table-new": { paths: ["M4 5h12v10H4z", "M4 9h12", "M9 5v10", "M19 14v6", "M16 17h6"] },
  "table-rename": { paths: ["M4 5h16v14H4z", "M4 10h16", "M8 14.5h8"] },
  "row-add": { paths: ["M4 6h16v5H4z", "M12 14v6", "M9 17h6"] },
  "row-delete": { paths: ["M4 6h16v5H4z", "M9 17h6"] },
  "column-add": { paths: ["M6 4v16h5V4z", "M14 12h6", "M17 9v6"] },
  "column-delete": { paths: ["M6 4v16h5V4z", "M14 12h6"] },
  merge: { paths: ["M4 5h16v14H4z", "M4 12h4", "M16 12h4", "m10 9-3 3 3 3", "m14 9 3 3-3 3"] },
  unmerge: { paths: ["M4 5h16v14H4z", "M12 5v14", "m8 9-3 3 3 3", "m16 9 3 3-3 3"] },
  cut: { paths: ["M6 3l8 12", "M18 3l-8 12", "M7 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M17 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"] },
  copy: { paths: ["M9 9h11v11H9z", "M5 15V4h11"] },
  paste: { paths: ["M8 5H5v16h14V5h-3", "M8 3h8v4H8z"] },
  "fill-down": { paths: ["M5 4h14v10H5z", "M12 15v6", "m9 18 3 3 3-3"] },
  "fill-right": { paths: ["M4 5h10v14H4z", "M15 12h6", "m18 9 3 3-3 3"] },
  clear: { paths: ["M6 6l12 12", "M18 6 6 18"] },
  "shift-right": { paths: ["M4 12h13", "m13 8 4 4-4 4", "M20 5v14"] },
  "shift-down": { paths: ["M12 4v13", "m8 13 4 4 4-4", "M5 20h14"] },
  "shift-left": { paths: ["M20 12H7", "m11 8-4 4 4 4", "M4 5v14"] },
  "shift-up": { paths: ["M12 20V7", "m8 11 4-4 4 4", "M5 4h14"] },
  "fill-all": { paths: ["M4 4h7v7H4z", "M13 13h7v7h-7z", "M13 4h7v7h-7z", "M4 13h7v7H4z"] },
  "row-height": { paths: ["M12 4v16", "m8 8 4-4 4 4", "m8 16 4 4 4-4"] },
  "column-width": { paths: ["M4 12h16", "m8 8-4 4 4 4", "m16 8 4 4-4 4"] },

  // history / file / view
  undo: { paths: ["M9 14 4 9l5-5", "M4 9h10a6 6 0 0 1 0 12h-3"] },
  redo: { paths: ["m15 14 5-5-5-5", "M20 9H10a6 6 0 0 0 0 12h3"] },
  save: { paths: ["M5 4h11l3 3v13H5z", "M8 4v5h7V4", "M8 20v-6h8v6"] },
  export: { paths: ["M12 15V4", "m8 8 4-4 4 4", "M5 15v5h14v-5"] },
  import: { paths: ["M12 4v11", "m8 11 4 4 4-4", "M5 15v5h14v-5"] },
  rename: { paths: ["M4 20h4L19 9l-4-4L4 16z", "m13.5 6.5 4 4"] },
  zoom: { paths: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-4-4", "M8.5 11h5", "M11 8.5v5"] },
  sidebar: { paths: ["M4 5h16v14H4z", "M9 5v14"] },
  file: { paths: ["M7 3h8l4 4v14H7z", "M15 3v4h4"] },

  // presentation seams
  "slide-new": { paths: ["M3 6h14v10H3z", "M20 8v8", "M17 12h6"] },
  layout: { paths: ["M4 5h16v14H4z", "M4 11h16", "M12 11v8"] },
  textbox: { paths: ["M5 5h14v14H5z", "M9 9h6", "M12 9v7"] },
  image: { paths: ["M4 5h16v14H4z", "m4 16 5-5 4 4 3-3 4 4", "M15 9h.01"] },
  shape: { paths: ["M12 4 4 19h16z"] },
  line: { paths: ["M5 19 19 5"] },
  theme: { paths: ["M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2-.6-1.2.2-2.5 1.6-2.5H17a4 4 0 0 0 4-4 9 9 0 0 0-9-9.5z", "M7.5 11h.01", "M10 7.5h.01", "M14.5 7.5h.01"] },
  background: { paths: ["M4 5h16v14H4z", "M4 15l4-4 4 4 3-3 5 5"] },
  transition: { paths: ["M4 7h9v10H4z", "M16 9l4 3-4 3"] },
  animation: { paths: ["M12 3l2.3 5.7L20 11l-5.7 2.3L12 19l-2.3-5.7L4 11l5.7-2.3z"] },

  // sidebar / chrome
  duplicate: { paths: ["M8 8h12v12H8z", "M4 16V4h12"] },
  rect: { paths: ["M4 6h16v12H4z"] },
  roundrect: { paths: ["M7 6h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z"] },
  ellipse: { paths: ["M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z"] },
  triangle: { paths: ["M12 4 4 19h16z"] },
  arrow: { paths: ["M4 9h9V5l7 7-7 7v-4H4z"] },
  "bring-front": { paths: ["M9 9h11v11H9z", "M4 15V4h11"] },
  "send-back": { paths: ["M4 4h11v11H4z", "M9 20h11V9"] },
  "bring-forward": { paths: ["M8 8h12v12H8z", "M4 4h8"] },
  "send-backward": { paths: ["M4 4h12v12H4z", "M12 20h8"] },
  "align-left": { paths: ["M4 6h16", "M4 10h10", "M4 14h16", "M4 18h10"] },
  "align-center": { paths: ["M4 6h16", "M7 10h10", "M4 14h16", "M7 18h10"] },
  "align-right": { paths: ["M4 6h16", "M10 10h10", "M4 14h16", "M10 18h10"] },
  inspector: { paths: ["M4 5h16v14H4z", "M15 5v14"] },
  grid: { paths: ["M4 4h16v16H4z", "M4 12h16", "M12 4v16"] },
  snap: { paths: ["M12 3v18", "M3 12h18", "M8 8h8v8H8z"] },
  plus: { paths: ["M12 5v14", "M5 12h14"] },
  more: { paths: ["M6 12h.01", "M12 12h.01", "M18 12h.01"] },
  chevron: { paths: ["m9 6 6 6-6 6"] },
  star: { paths: ["m12 3.5 2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.4 2.8 1-6L3.3 9.9l6-.9z"] },
  trash: { paths: ["M5 7h14", "M9 7V4h6v3", "M7 7l1 13h8l1-13"] },
  search: { paths: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-4-4"] },
  "page-document": { paths: ["M7 3h8l4 4v14H7z", "M15 3v4h4", "M10 12h6", "M10 16h6"] },
  "page-sheet": { paths: ["M4 5h16v14H4z", "M4 10h16", "M4 15h16", "M10 5v14", "M15 5v14"] },
  "page-presentation": { paths: ["M3 5h18v12H3z", "M8 21h8", "M12 17v4"] }
};

/**
 * Build an icon element.
 * @param {string} name Key of the icon set; unknown names fall back to a dot.
 * @param {{ size?: number, class?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, options = {}) {
  const spec = ICONS[name] ?? { paths: ["M12 12h.01"] };
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(options.size ?? 20));
  svg.setAttribute("height", String(options.size ?? 20));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `icon icon-${name}${options.class ? ` ${options.class}` : ""}`);
  svg.setAttribute("data-icon", name);

  for (const d of spec.paths ?? []) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }

  if (spec.text) {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", "12");
    text.setAttribute("y", "17");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", spec.text.length > 1 ? "12" : "15");
    text.setAttribute("font-weight", spec.style === "bold" || spec.text.length > 1 ? "700" : "500");
    text.setAttribute("fill", "currentColor");
    text.setAttribute("stroke", "none");
    if (spec.style === "italic") text.setAttribute("font-style", "italic");
    if (spec.style === "underline") text.setAttribute("text-decoration", "underline");
    if (spec.style === "strike") text.setAttribute("text-decoration", "line-through");
    text.textContent = spec.text;
    svg.appendChild(text);
  }

  return svg;
}

/** @param {string} name */
export function hasIcon(name) {
  return name in ICONS;
}
