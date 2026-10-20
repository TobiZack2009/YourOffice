/**
 * Inline SVG icons for the ribbon and sidebar.
 *
 * Most icons come from the Lucide pack (`lucide` on npm). Only the icons used here
 * are imported by name, so the bundler drops the rest of the pack. A handful of
 * icons have no Lucide equivalent (letter glyphs, cell-shift arrows, row/column
 * variants) and are drawn locally in the same 24x24 outline style.
 *
 * Every icon is drawn with `currentColor`, so it follows the surrounding text colour
 * (and the per-page-type accent). Elements are built with `createElementNS`; no
 * markup strings are ever parsed.
 */

import {
  ArrowDownToLine,
  ArrowRight,
  ArrowRightLeft,
  ArrowRightToLine,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  Bold,
  Bookmark,
  BringToFront,
  Check,
  Circle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsRight,
  ClipboardPaste,
  Code,
  Copy,
  CopyPlus,
  Download,
  Ellipsis,
  Equal,
  Eraser,
  ExternalLink,
  File,
  FileSpreadsheet,
  FileSymlink,
  FileText,
  Grid3x3,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  LayoutTemplate,
  Link,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  Magnet,
  Minus,
  MousePointerClick,
  MoveHorizontal,
  MoveVertical,
  PaintBucket,
  Palette,
  PanelLeft,
  PanelRight,
  Pencil,
  Pilcrow,
  Play,
  Plus,
  Presentation,
  Quote,
  RectangleHorizontal,
  Redo2,
  Route,
  Save,
  Scissors,
  Search,
  SendToBack,
  Shapes,
  Sigma,
  Slash,
  Sparkles,
  Square,
  SquareCode,
  SquarePlus,
  Star,
  Strikethrough,
  Table,
  TableCellsMerge,
  TableCellsSplit,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TextCursorInput,
  Trash,
  Triangle,
  Type,
  Underline,
  Undo2,
  Unlink,
  Upload,
  ZoomIn
} from "lucide";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A Lucide-style icon node: a list of `[tag, attributes]` children.
 * @typedef {Array<[string, Record<string, string | number>]>} IconNode
 */

/**
 * Local icon drawn from path data only.
 * @param {...string} paths
 * @returns {IconNode}
 */
const drawn = (...paths) => paths.map((d) => ["path", { d }]);

/**
 * Icon definitions by name: each is a Lucide icon node or a locally drawn one.
 * @type {Record<string, { node: IconNode }>}
 */
const ICONS = {
  // text styles
  paragraph: { node: Pilcrow },
  h1: { node: Heading1 },
  h2: { node: Heading2 },
  h3: { node: Heading3 },
  bold: { node: Bold },
  italic: { node: Italic },
  underline: { node: Underline },
  strike: { node: Strikethrough },
  code: { node: Code },
  "code-block": { node: SquareCode },
  link: { node: Link },
  list: { node: List },
  quote: { node: Quote },
  divider: { node: Minus },
  indent: { node: ListIndentIncrease },
  outdent: { node: ListIndentDecrease },
  "page-link": { node: FileSymlink },

  // embeds / sheet / slide objects
  sheet: { node: Table },
  slide: { node: Presentation },
  table: { node: Table },
  "table-new": { node: drawn("M4 5h12v10H4z", "M4 9h12", "M9 5v10", "M19 14v6", "M16 17h6") },
  "table-rename": { node: TextCursorInput },
  "row-add": { node: BetweenHorizontalStart },
  "row-delete": { node: drawn("M4 6h16v5H4z", "M9 17h6") },
  "column-add": { node: BetweenVerticalStart },
  "column-delete": { node: drawn("M6 4v16h5V4z", "M14 12h6") },
  merge: { node: TableCellsMerge },
  unmerge: { node: TableCellsSplit },
  cut: { node: Scissors },
  copy: { node: Copy },
  paste: { node: ClipboardPaste },
  "fill-down": { node: ArrowDownToLine },
  "fill-right": { node: ArrowRightToLine },
  clear: { node: Eraser },
  "shift-right": { node: drawn("M4 12h13", "m13 8 4 4-4 4", "M20 5v14") },
  "shift-down": { node: drawn("M12 4v13", "m8 13 4 4 4-4", "M5 20h14") },
  "shift-left": { node: drawn("M20 12H7", "m11 8-4 4 4 4", "M4 5v14") },
  "shift-up": { node: drawn("M12 20V7", "m8 11 4-4 4 4", "M5 4h14") },
  "fill-all": { node: drawn("M4 4h7v7H4z", "M13 13h7v7h-7z", "M13 4h7v7h-7z", "M4 13h7v7H4z") },
  "row-height": { node: MoveVertical },
  "column-width": { node: MoveHorizontal },

  // history / file / view
  undo: { node: Undo2 },
  redo: { node: Redo2 },
  save: { node: Save },
  export: { node: Upload },
  import: { node: Download },
  rename: { node: Pencil },
  zoom: { node: ZoomIn },
  sidebar: { node: PanelLeft },
  file: { node: File },

  // presentation
  "slide-new": { node: SquarePlus },
  layout: { node: LayoutTemplate },
  textbox: { node: Type },
  image: { node: Image },
  shape: { node: Shapes },
  line: { node: Slash },
  theme: { node: Palette },
  background: { node: PaintBucket },
  transition: { node: ArrowRightLeft },
  animation: { node: Sparkles },
  play: { node: Play },
  stop: { node: Square },
  "on-click": { node: MousePointerClick },
  "with-previous": { node: Equal },
  "after-previous": { node: ChevronsRight },
  "motion-path": { node: Route },
  grip: { node: GripVertical },
  section: { node: Bookmark },
  expression: { node: Sigma },
  unlink: { node: Unlink },
  "go-to": { node: ExternalLink },
  "move-up": { node: ChevronUp },
  "move-down": { node: ChevronDown },

  // sidebar / chrome
  duplicate: { node: CopyPlus },
  rect: { node: drawn("M4 6h16v12H4z") },
  roundrect: { node: RectangleHorizontal },
  ellipse: { node: Circle },
  triangle: { node: Triangle },
  arrow: { node: ArrowRight },
  "bring-front": { node: BringToFront },
  "send-back": { node: SendToBack },
  "bring-forward": { node: drawn("M8 8h12v12H8z", "M4 4h8") },
  "send-backward": { node: drawn("M4 4h12v12H4z", "M12 20h8") },
  "align-left": { node: TextAlignStart },
  "align-center": { node: TextAlignCenter },
  "align-right": { node: TextAlignEnd },
  inspector: { node: PanelRight },
  grid: { node: Grid3x3 },
  snap: { node: Magnet },
  plus: { node: Plus },
  check: { node: Check },
  more: { node: Ellipsis },
  chevron: { node: ChevronRight },
  star: { node: Star },
  trash: { node: Trash },
  search: { node: Search },
  "page-document": { node: FileText },
  "page-sheet": { node: FileSpreadsheet },
  "page-presentation": { node: Presentation }
};

/**
 * Build an icon element.
 * @param {string} name Key of the icon set; unknown names fall back to a dot.
 * @param {{ size?: number, class?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, options = {}) {
  const spec = ICONS[name] ?? { node: drawn("M12 12h.01") };
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

  for (const [tag, attributes] of spec.node) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, String(value));
    svg.appendChild(child);
  }

  return svg;
}

/** @param {string} name */
export function hasIcon(name) {
  return name in ICONS;
}
