/**
 * What every exporter needs and shares in one run: the workspace data, one formula engine and
 * one expression book (built once), asset addresses, and where a link to another page points.
 */

import { TableEngines, buildBook } from "../references/table-engine.js";
import { relativePath } from "./names.js";

/**
 * @typedef {object} ExportEnv
 * @property {Document} [document] DOM implementation for HTML and SVG output.
 */

/**
 * @typedef {object} ExportContext
 * @property {import("../workspace/store.js").Workspace} workspace
 * @property {any} data
 * @property {import("./plan.js").ExportPlan} plan
 * @property {Document | undefined} document
 * @property {TableEngines} engines
 * @property {import("../calc/recalc.js").RecalcEngine} book
 * @property {(assetId: string) => string | undefined} assetUrl A `data:` address for a stored image.
 * @property {(pageId: string) => string} titleOf The page's title, "Untitled" when blank.
 * @property {(fromPath: string, pageId: string) => string | null} hrefFor Where a link from the file at
 *   `fromPath` to a page points, or null when that page is not in the export.
 * @property {(containerId: string, slideId: string) => string} [slideImage] A slide as an SVG `data:`
 *   address (set by the exporter that can draw it).
 * @property {string[]} warnings Things that could not be exported faithfully, for the caller to show.
 */

/**
 * @param {import("../workspace/store.js").Workspace} workspace
 * @param {import("./plan.js").ExportPlan} plan
 * @param {ExportEnv} [env]
 * @returns {ExportContext}
 */
export function createContext(workspace, plan, env = {}) {
  const data = workspace.data;
  /** @type {Map<string, string | undefined>} */
  const urls = new Map();
  const single = plan.request.layout === "single";
  return {
    workspace,
    data,
    plan,
    document: env.document,
    engines: new TableEngines(() => data),
    book: buildBook(data),
    warnings: [],
    assetUrl(assetId) {
      if (!urls.has(assetId)) {
        const asset = workspace.getAsset(assetId);
        urls.set(assetId, asset ? `data:${asset.mimeType};base64,${asset.storage.data}` : undefined);
      }
      return urls.get(assetId);
    },
    titleOf: (pageId) => data.pages[pageId]?.title || "Untitled",
    hrefFor(fromPath, pageId) {
      const target = plan.byId.get(pageId);
      if (!target) return null;
      return single ? `#${target.anchor}` : relativePath(fromPath, target.path);
    }
  };
}

/**
 * What the read-only renderers need of the context.
 * @param {ExportContext} ctx
 * @returns {import("./static-render.js").StaticContext}
 */
export function staticContext(ctx) {
  return {
    data: ctx.data,
    engines: ctx.engines,
    book: ctx.book,
    document: ctx.document,
    resolvePageTitle: ctx.titleOf,
    resolveAssetUrl: ctx.assetUrl
  };
}

/**
 * A short description of a slide: the text of its first text object.
 * @param {any} slide
 * @returns {string}
 */
export function slideLabel(slide) {
  for (const id of slide?.objectOrder ?? []) {
    const object = slide.objects?.[id];
    if (object?.type !== "text") continue;
    const text = (object.text?.runs ?? [])
      .map((/** @type {any} */ run) => (run.ref ? "" : run.text))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  }
  return "";
}
