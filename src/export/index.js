/**
 * Export entry point: plan what goes where, draw it in the requested format, and (when there
 * is more than one file) bundle it as a zip.
 *
 *   const result = exportPages(workspace, { format: "html", pageIds: [id] }, { document });
 *   const download = bundleExport(result, "My notes");
 *
 * HTML and slide images need a DOM implementation; pass it as `env.document`. Nothing here
 * touches the workspace.
 */

import { createContext } from "./context.js";
import { tableRows, toCsv } from "./csv.js";
import { utf8 } from "./encode.js";
import { exportHtml } from "./html-render.js";
import { exportMarkdown } from "./markdown.js";
import { slugify, uniqueName } from "./names.js";
import { planExport } from "./plan.js";
import { provideSlideImages } from "./slide-svg-render.js";
import { createZip } from "./zip.js";

const MIME = { html: "text/html", markdown: "text/markdown", csv: "text/csv" };

/**
 * @typedef {object} ExportFile
 * @property {string} path `/`-separated, from the export root.
 * @property {string} mime
 * @property {string} text
 */

/**
 * @typedef {object} ExportResult
 * @property {ExportFile[]} files
 * @property {{ pageId: string, title: string, reason: string }[]} skipped Pages left out, and why.
 * @property {string[]} warnings Things that could not be exported faithfully.
 * @property {import("./plan.js").ExportPlan} plan
 */

/**
 * One CSV file per table: a sheet with one table is `<stem>.csv`, one with several is
 * `<stem>-<table>.csv`.
 * @param {import("./context.js").ExportContext} ctx
 * @returns {{ path: string, text: string }[]}
 */
function exportCsv(ctx) {
  const used = new Set(ctx.plan.taken);
  /** @type {{ path: string, text: string }[]} */
  const files = [];
  for (const page of ctx.plan.pages) {
    const content = ctx.data.pages[page.id]?.content;
    const ids = /** @type {string[]} */ ((content?.tableOrder ?? []).filter((/** @type {string} */ id) => content.tables[id]));
    if (ids.length === 0) {
      ctx.warnings.push(`"${page.title || "Untitled"}" has no tables.`);
      continue;
    }
    for (const id of ids) {
      const table = content.tables[id];
      const stem = ids.length === 1 ? page.stem : uniqueName(`${page.stem}-${slugify(table.name, "table")}`, used);
      files.push({ path: `${stem}.csv`, text: toCsv(tableRows(table, ctx.engines)) });
    }
  }
  return files;
}

/**
 * Draw the requested pages.
 * @param {import("../workspace/store.js").Workspace} workspace
 * @param {import("./plan.js").ExportRequest} request
 * @param {import("./context.js").ExportEnv} [env]
 * @returns {ExportResult}
 */
export function exportPages(workspace, request, env = {}) {
  const plan = planExport(workspace, request);
  const ctx = createContext(workspace, plan, env);
  const { format } = plan.request;
  if (plan.pages.length === 0) ctx.warnings.push("There is nothing to export.");

  /** @type {{ path: string, text: string }[]} */
  let drawn = [];
  if (format === "csv") drawn = exportCsv(ctx);
  else if (format === "markdown") {
    if (ctx.document) provideSlideImages(ctx);
    drawn = exportMarkdown(ctx);
  } else drawn = exportHtml(ctx);

  return {
    files: drawn.map((file) => ({ ...file, mime: MIME[format] })),
    skipped: plan.skipped,
    warnings: [...new Set(ctx.warnings)],
    plan
  };
}

/**
 * What the user downloads: the file itself when there is one, otherwise a zip of them all.
 * @param {ExportResult} result
 * @param {string} name What to call the download when it is a zip (without extension).
 * @param {Date} [date] Time stamped on zip entries.
 * @returns {{ name: string, mime: string, bytes: Uint8Array } | null} Null when there is nothing.
 */
export function bundleExport(result, name, date) {
  const { files } = result;
  if (files.length === 0) return null;
  if (files.length === 1) return { name: files[0].path.split("/").pop() ?? files[0].path, mime: files[0].mime, bytes: utf8(files[0].text) };
  const stem = slugify(name, "export");
  return {
    name: `${stem}.zip`,
    mime: "application/zip",
    bytes: createZip(
      files.map((file) => ({ path: file.path, data: utf8(file.text) })),
      date
    )
  };
}
