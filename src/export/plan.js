/**
 * What an export contains and where each piece goes, decided before anything is drawn.
 *
 * The request names pages; the plan adds their children (unless asked not to) and the pages
 * they link to (unless asked not to), puts them in sidebar order, and gives every page a
 * file path that is unique under a case-insensitive comparison. Nothing here reads page
 * content except to find links.
 */

import { pageTree } from "../workspace/selectors.js";
import { nameKey, slugify } from "./names.js";

/**
 * @typedef {object} ExportRequest
 * @property {"html" | "markdown" | "csv"} format
 * @property {string[]} [pageIds] The pages to export; every page when empty or absent.
 * @property {boolean} [includeChildren] Also export each page's sub-pages (default true).
 * @property {boolean} [includeLinked] Also export pages reachable through links (default true).
 * @property {"files" | "single"} [layout] Separate files (zipped when there is more than one), or
 *   one file with each page under a heading (default "files").
 * @property {boolean} [subfolders] Mirror the page tree as folders (files layout only, default false).
 * @property {"headings" | "target"} [sectionStyle] Single-file HTML: show every page one after
 *   another, or only the one named in the address (default "headings").
 * @property {{ mode?: "gallery" | "subpages", format?: "svg" }} [slides] Presentations: all slides on
 *   the page, or one sub-page per slide (default gallery). Slides are SVG.
 */

/**
 * @typedef {object} NormalizedRequest
 * @property {"html" | "markdown" | "csv"} format
 * @property {string[]} pageIds
 * @property {boolean} includeChildren
 * @property {boolean} includeLinked
 * @property {"files" | "single"} layout
 * @property {boolean} subfolders
 * @property {"headings" | "target"} sectionStyle
 * @property {{ mode: "gallery" | "subpages", format: "svg" }} slides
 */

/**
 * @typedef {object} PlanPage
 * @property {string} id
 * @property {string} title
 * @property {"document" | "sheet" | "presentation"} type
 * @property {number} depth 0 for a top-level page of the export; one more per included ancestor.
 * @property {"selected" | "child" | "linked"} origin
 * @property {string} path File path from the export root (the stem plus extension), `/`-separated.
 * @property {string} stem Path without the extension.
 * @property {string} anchor Fragment id used in single-file output.
 * @property {string[]} slidePaths One file per slide when slides are sub-pages.
 */

/**
 * @typedef {object} ExportPlan
 * @property {NormalizedRequest} request
 * @property {PlanPage[]} pages In sidebar order.
 * @property {{ pageId: string, title: string, reason: string }[]} skipped
 * @property {Map<string, PlanPage>} byId
 * @property {string} extension
 * @property {string | null} indexPath The overview file of a multi-page export, if any.
 * @property {string} singlePath The file name of a single-file export.
 * @property {Set<string>} taken Every file stem (with its folder) already in use, by `nameKey`.
 */

const EXTENSION = { html: "html", markdown: "md", csv: "csv" };

/**
 * @param {ExportRequest} request
 * @returns {NormalizedRequest}
 */
export function normalizeRequest(request) {
  const format = request?.format === "markdown" || request?.format === "csv" ? request.format : "html";
  return {
    format,
    pageIds: Array.isArray(request?.pageIds) ? [...new Set(request.pageIds)] : [],
    includeChildren: request?.includeChildren !== false,
    includeLinked: request?.includeLinked !== false,
    layout: request?.layout === "single" && format !== "csv" ? "single" : "files",
    subfolders: request?.subfolders === true,
    sectionStyle: request?.sectionStyle === "target" ? "target" : "headings",
    slides: { mode: request?.slides?.mode === "subpages" ? "subpages" : "gallery", format: "svg" }
  };
}

/**
 * The page a link address names (`#<pageId>`), when that page exists.
 * @param {any} data
 * @param {unknown} url
 * @returns {string | null}
 */
export function pageOfLink(data, url) {
  if (typeof url !== "string" || !url.startsWith("#")) return null;
  const id = url.slice(1);
  return data.pages[id] ? id : null;
}

/**
 * Pages a document links to: page-link blocks and links to `#<pageId>` in its text. Content
 * drawn into the page from elsewhere is part of this page's output, so it adds no pages.
 * @param {any} data
 * @param {string} pageId
 * @returns {string[]}
 */
export function linkedPageIds(data, pageId) {
  const page = data.pages[pageId];
  if (page?.type !== "document" || !page.content?.blocks) return [];
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {any[] | undefined} runs */
  const scan = (runs) => {
    for (const run of runs ?? []) {
      const target = pageOfLink(data, run?.marks?.link);
      if (target) found.add(target);
    }
  };
  for (const block of Object.values(page.content.blocks)) {
    const b = /** @type {any} */ (block);
    if (b.type === "pageLink" && data.pages[b.pageId]) found.add(b.pageId);
    scan(b.runs);
    for (const item of b.items ?? []) scan(item.runs);
  }
  found.delete(pageId);
  return [...found];
}

/**
 * @param {import("../workspace/store.js").Workspace} workspace
 * @param {ExportRequest} input
 * @returns {ExportPlan}
 */
export function planExport(workspace, input) {
  const request = normalizeRequest(input);
  const data = workspace.data;
  const tree = pageTree(workspace);

  /** @type {Map<string, any>} */
  const nodes = new Map();
  /** @type {Map<string, string | null>} */
  const parentOf = new Map();
  /** @param {any[]} list @param {string | null} parent */
  const index = (list, parent) => {
    for (const node of list) {
      nodes.set(node.id, node);
      parentOf.set(node.id, parent);
      index(node.children, node.id);
    }
  };
  index(tree, null);

  const roots = request.pageIds.length > 0 ? request.pageIds.filter((id) => nodes.has(id)) : tree.map((node) => node.id);

  /** @type {Map<string, "selected" | "child" | "linked">} */
  const included = new Map();
  /** @param {string} id */
  const addChildren = (id) => {
    for (const child of nodes.get(id).children) {
      if (!included.has(child.id)) included.set(child.id, "child");
      addChildren(child.id);
    }
  };
  for (const id of roots) {
    included.set(id, "selected");
    if (request.includeChildren) addChildren(id);
  }

  // Pages the included documents link to, and whatever those link to in turn.
  if (request.includeLinked && request.format !== "csv") {
    const queue = [...included.keys()];
    while (queue.length > 0) {
      const id = /** @type {string} */ (queue.shift());
      for (const target of linkedPageIds(data, id)) {
        if (included.has(target)) continue;
        included.set(target, "linked");
        queue.push(target);
        if (request.includeChildren) {
          const before = new Set(included.keys());
          addChildren(target);
          for (const added of included.keys()) if (!before.has(added)) queue.push(added);
        }
      }
    }
  }

  /** @type {ExportPlan["skipped"]} */
  const skipped = [];
  if (request.format === "csv") {
    for (const [id] of [...included]) {
      if (data.pages[id].type === "sheet") continue;
      included.delete(id);
      skipped.push({ pageId: id, title: data.pages[id].title, reason: "Only sheets export as CSV." });
    }
  }

  const extension = EXTENSION[request.format];
  const single = request.layout === "single";
  const taken = new Set(["index"]);
  /** @type {PlanPage[]} */
  const pages = [];
  /** @type {Map<string, PlanPage>} */
  const byId = new Map();

  /**
   * @param {any[]} list Tree nodes in sidebar order.
   * @param {number} depth
   * @param {string} dir Folder of the pages at this level ("" for the root, otherwise ends with "/").
   */
  const walk = (list, depth, dir) => {
    for (const node of list) {
      const origin = included.get(node.id);
      if (!origin) {
        walk(node.children, depth, dir);
        continue;
      }
      const base = slugify(node.title);
      let stemName = base;
      for (let n = 2; taken.has(nameKey(`${dir}${stemName}`)); n++) stemName = `${base}-${n}`;
      const stem = `${dir}${stemName}`;
      taken.add(nameKey(stem));
      /** @type {PlanPage} */
      const page = {
        id: node.id,
        title: node.title,
        type: node.type,
        depth,
        origin,
        stem,
        path: `${stem}.${extension}`,
        anchor: `page-${stemName.replace(/\//g, "-")}`,
        slidePaths: []
      };
      if (request.slides.mode === "subpages" && node.type === "presentation" && !single && request.format !== "csv") {
        const count = /** @type {any} */ (data.pages[node.id].content)?.slideOrder?.length ?? 0;
        for (let n = 1; n <= count; n++) {
          taken.add(nameKey(`${stem}/slide-${n}`));
          page.slidePaths.push(`${stem}/slide-${n}.${extension}`);
        }
      }
      pages.push(page);
      byId.set(page.id, page);
      walk(node.children, depth + 1, request.subfolders && !single ? `${stem}/` : dir);
    }
  };
  walk(tree, 0, "");

  const multiple = pages.length > 1 || pages.some((page) => page.slidePaths.length > 0);
  return {
    request,
    pages,
    skipped,
    byId,
    extension,
    indexPath: !single && multiple && request.format !== "csv" ? `index.${extension}` : null,
    singlePath: `${pages.length === 1 ? pages[0].stem : "export"}.${extension}`,
    taken
  };
}
