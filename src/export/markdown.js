/**
 * Pages as Markdown (CommonMark plus GFM tables and strikethrough). Pure text: no DOM.
 *
 * Images and slides are reference-style (`![alt][image-1]`, definitions at the end of the
 * file), so a paragraph stays readable. Embedded content is written inline where it appears;
 * expressions are written as their result.
 */

import { displayValue } from "../calc/evaluator.js";
import { isHandle, isRange, rangeDims } from "../calc/values.js";
import { isSafeUrl } from "../core/url.js";
import { evaluateExpression } from "../references/expression.js";
import { findSection, sectionKind, sectionPlainText, sectionRunIds, sectionSlideIds } from "../references/sections.js";
import { slideLabel } from "./context.js";
import { tableRows } from "./csv.js";
import { pageOfLink } from "./plan.js";
import { relativePath } from "./names.js";

const MAX_DEPTH = 6;

/**
 * @typedef {object} MdFile
 * @property {Map<string, string>} labels Address -> label of its definition.
 * @property {string[]} definitions
 * @property {Record<string, number>} counts
 */

/**
 * @typedef {object} MdEnv
 * @property {MdFile} file
 * @property {string} fromPath File being written, for relative links.
 * @property {string} containerId The page whose content is being written.
 * @property {any} content That page's content.
 * @property {number} titleLevel Heading level of the page's own title.
 * @property {number} depth Nesting of embedded content.
 */

/**
 * @typedef {{ path: string, text: string }} MdOutput
 */

// -- text ----------------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
  return text.replace(/[\\`*_[\]<>~]/g, "\\$&").replace(/&(?=#?\w+;)/g, "\\&");
}

/**
 * Stop a line of text from reading as a heading, list item or rule.
 * @param {string} text
 * @returns {string}
 */
function escapeLineStarts(text) {
  return text
    .replace(/^(\s*)(#{1,6})(?=\s|$)/gm, "$1\\$2")
    .replace(/^(\s*)([-+])(?=\s|$)/gm, "$1\\$2")
    .replace(/^(\s*)(\d+)([.)])(?=\s|$)/gm, "$1$2\\$3")
    .replace(/^(\s*)(=+)\s*$/gm, "$1\\$2");
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeAlt(text) {
  return text.replace(/\s+/g, " ").replace(/[\\[\]]/g, "\\$&");
}

/**
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function codeSpan(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function encodeTarget(url) {
  return url.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

// -- definitions ---------------------------------------------------------------------------

/** @returns {MdFile} */
function newFile() {
  return { labels: new Map(), definitions: [], counts: {} };
}

/**
 * The label of a definition for an address, adding it the first time.
 * @param {MdFile} file
 * @param {string} url
 * @param {"image" | "slide"} prefix
 * @returns {string}
 */
function defineAddress(file, url, prefix) {
  const known = file.labels.get(url);
  if (known) return known;
  const n = (file.counts[prefix] = (file.counts[prefix] ?? 0) + 1);
  const label = `${prefix}-${n}`;
  file.labels.set(url, label);
  file.definitions.push(`[${label}]: ${url}`);
  return label;
}

/**
 * @param {MdFile} file
 * @param {string} text
 * @returns {string}
 */
function finish(file, text) {
  const body = text.replace(/\n{3,}/g, "\n\n").trimEnd();
  return `${body}${file.definitions.length > 0 ? `\n\n${file.definitions.join("\n")}` : ""}\n`;
}

// -- inline --------------------------------------------------------------------------------

/**
 * Adjacent runs with the same marks read as one.
 * @param {any[]} runs
 * @returns {any[]}
 */
function mergeRuns(runs) {
  /** @type {any[]} */
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (!run.ref && last && !last.ref && markKey(last.marks) === markKey(run.marks)) last.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

/**
 * @param {any} marks
 * @returns {string}
 */
function markKey(marks) {
  const m = marks ?? {};
  return [m.bold, m.italic, m.underline, m.strike, m.code, m.link].map((v) => v ?? "").join("|");
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {string} link
 * @param {MdEnv} env
 * @returns {string | null}
 */
function linkTarget(ctx, link, env) {
  const pageId = pageOfLink(ctx.data, link);
  if (pageId) {
    const href = ctx.hrefFor(env.fromPath, pageId);
    return href ? encodeTarget(href) : null;
  }
  return isSafeUrl(link) ? encodeTarget(link) : null;
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {any} run
 * @param {MdEnv} env
 * @returns {string}
 */
function runMarkdown(ctx, run, env) {
  const marks = run.marks ?? {};
  const raw = String(run.text ?? "");
  const lead = /^\s*/.exec(raw)?.[0] ?? "";
  const trail = raw.length > lead.length ? (/\s*$/.exec(raw)?.[0] ?? "") : "";
  const core = raw.slice(lead.length, raw.length - trail.length);
  const space = (/** @type {string} */ s) => s.replace(/\n/g, "  \n");
  if (core === "") return space(raw);
  let body = marks.code ? codeSpan(core.replace(/\s*\n\s*/g, " ")) : space(escapeText(core));
  if (marks.strike) body = `~~${body}~~`;
  if (marks.underline) body = `<u>${body}</u>`;
  if (marks.italic) body = `*${body}*`;
  if (marks.bold) body = `**${body}**`;
  const target = marks.link ? linkTarget(ctx, marks.link, env) : null;
  if (target) body = `[${body}](${target})`;
  return space(lead) + body + space(trail);
}

/**
 * What a value reads as inside a line of text.
 * @param {import("./context.js").ExportContext} ctx
 * @param {any} value
 * @returns {string}
 */
function valueInline(ctx, value) {
  if (isHandle(value)) return oneLine(sectionPlainText(ctx.data, value.sectionId) ?? "");
  if (isRange(value)) {
    const { rows, cols } = rangeDims(value);
    const lines = [];
    for (let r = 0; r < rows; r++) {
      const cells = [];
      for (let c = 0; c < cols; c++) cells.push(displayValue(value[r * cols + c] ?? null));
      lines.push(cells.join(", "));
    }
    return lines.join("; ");
  }
  return displayValue(value);
}

/**
 * An inline reference, as text.
 * @param {import("./context.js").ExportContext} ctx
 * @param {any} ref
 * @param {MdEnv} env
 * @returns {string}
 */
function refInline(ctx, ref, env) {
  if (ref.kind === "expression") {
    const result = evaluateExpression(ctx.data, env.containerId, ref.expression ?? "", { book: ctx.book });
    return escapeText(valueInline(ctx, result.value));
  }
  const found = ref.sectionId ? findSection(ctx.data, ref.sectionId) : null;
  if (!found) return "";
  if (sectionKind(found) === "table") {
    return escapeText(found.container.content.tables?.[found.section.locator.tableId]?.name ?? "");
  }
  return escapeText(oneLine(sectionPlainText(ctx.data, ref.sectionId) ?? ""));
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {any[] | undefined} runs
 * @param {MdEnv} env
 * @returns {string}
 */
function inline(ctx, runs, env) {
  return mergeRuns(runs ?? [])
    .map((run) => (run.ref ? refInline(ctx, run.ref, env) : runMarkdown(ctx, run, env)))
    .join("");
}

// -- blocks --------------------------------------------------------------------------------

/**
 * @param {string[][]} rows The first row is the header.
 * @returns {string}
 */
function gfmTable(rows) {
  if (rows.length === 0) return "";
  const cell = (/** @type {string} */ text) => escapeText(text).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  const line = (/** @type {string[]} */ cells) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(rows[0]), `| ${rows[0].map(() => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

/**
 * @param {string} text
 * @param {string} [language]
 * @returns {string}
 */
function fence(text, language) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${(language ?? "").replace(/[^\w+#.-]/g, "")}\n${text}\n${ticks}`;
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {MdEnv} env
 * @param {string} containerId
 * @param {any} content
 * @param {string} slideId
 * @returns {string}
 */
function slideMarkdown(ctx, env, containerId, content, slideId) {
  const slide = content.slides?.[slideId];
  const number = (content.slideOrder ?? []).indexOf(slideId) + 1;
  const label = slideLabel(slide);
  const alt = `Slide ${number}${label ? `: ${label}` : ""}`;
  const url = ctx.slideImage?.(containerId, slideId);
  if (!url) {
    const warning = "Slides could not be drawn here, so they are listed by name only.";
    if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
    return `*${escapeText(alt)}*`;
  }
  return `![${escapeAlt(alt)}][${defineAddress(env.file, url, "slide")}]`;
}

/**
 * Embedded content, written where it is embedded.
 * @param {import("./context.js").ExportContext} ctx
 * @param {string | undefined} sectionId
 * @param {MdEnv} env
 * @returns {string}
 */
function embedMarkdown(ctx, sectionId, env) {
  if (env.depth >= MAX_DEPTH) return "*Too many levels of embedded content.*";
  const found = sectionId ? findSection(ctx.data, sectionId) : null;
  if (!found) return "*The source was removed.*";
  const { container, section, containerId } = found;
  const kind = sectionKind(found);
  if (kind === "table") {
    const table = container.content.tables?.[section.locator.tableId];
    if (!table) return "*The table is gone.*";
    return gfmTable(tableRows(table, ctx.engines, section.locator.range));
  }
  if (kind === "slide") {
    const ids = sectionSlideIds(container.content, section.locator);
    if (ids.length === 0) return "*The slide is gone.*";
    return ids.map((id) => slideMarkdown(ctx, env, containerId, container.content, id)).join("\n\n");
  }
  const inner = { ...env, containerId, content: container.content, depth: env.depth + 1 };
  return sectionRunIds(container.content, section.locator)
    .map((id) => (container.content.blocks[id] ? blockMarkdown(ctx, container.content.blocks[id], inner) : ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {any} block
 * @param {MdEnv} env
 * @returns {string}
 */
function listMarkdown(ctx, block, env) {
  /** @type {string[]} */
  const entries = [];
  (block.items ?? []).forEach((/** @type {any} */ item, /** @type {number} */ index) => {
    const marker = block.ordered ? `${index + 1}. ` : "- ";
    const pad = " ".repeat(marker.length);
    const lines = escapeLineStarts(inline(ctx, item.runs, env)).split("\n");
    let entry = (lines[0] === "" && lines.length === 1 ? marker.trimEnd() : marker + lines[0]) + lines.slice(1).map((l) => `\n${pad}${l}`).join("");
    for (const childId of item.children ?? []) {
      const child = env.content.blocks?.[childId];
      const text = child ? blockMarkdown(ctx, child, env) : "";
      if (!text) continue;
      const indented = text.split("\n").map((l) => (l === "" ? "" : pad + l)).join("\n");
      entry += (child.type === "list" ? "\n" : "\n\n") + indented;
    }
    entries.push(entry);
  });
  return entries.join("\n");
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {any} block
 * @param {MdEnv} env
 * @returns {string} Empty when the block has nothing to write.
 */
function blockMarkdown(ctx, block, env) {
  switch (block.type) {
    case "paragraph": {
      const text = escapeLineStarts(inline(ctx, block.runs, env));
      return text.trim() === "" ? "" : text;
    }
    case "quote": {
      const text = escapeLineStarts(inline(ctx, block.runs, env));
      return text.trim() === "" ? "" : text.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
    }
    case "heading": {
      const level = Math.min(6, env.titleLevel + Math.min(3, Math.max(1, block.level ?? 1)));
      const text = oneLine(inline(ctx, block.runs, env));
      return text === "" ? "" : `${"#".repeat(level)} ${text}`;
    }
    case "list":
      return listMarkdown(ctx, block, env);
    case "code":
      return fence(block.text ?? "", block.language);
    case "divider":
      return "---";
    case "image": {
      const url = block.assetId ? ctx.assetUrl(block.assetId) : undefined;
      if (!url) {
        ctx.warnings.push(`An image is missing from the workspace${block.alt ? ` ("${block.alt}")` : ""}.`);
        return `*${escapeText(block.alt || "Missing image")}*`;
      }
      return `![${escapeAlt(block.alt ?? "")}][${defineAddress(env.file, url, "image")}]`;
    }
    case "pageLink": {
      const title = escapeText(ctx.titleOf(block.pageId));
      const href = ctx.data.pages[block.pageId] ? ctx.hrefFor(env.fromPath, block.pageId) : null;
      return href ? `[${title}](${encodeTarget(href)})` : title;
    }
    case "sectionRef": {
      if (block.kind === "expression") {
        const result = evaluateExpression(ctx.data, env.containerId, block.expression ?? "", { book: ctx.book });
        return valueBlock(ctx, result.value, env);
      }
      return embedMarkdown(ctx, block.sectionId, env);
    }
    default:
      return "";
  }
}

/**
 * An expression's value on its own line(s).
 * @param {import("./context.js").ExportContext} ctx
 * @param {any} value
 * @param {MdEnv} env
 * @returns {string}
 */
function valueBlock(ctx, value, env) {
  if (isHandle(value)) return embedMarkdown(ctx, value.sectionId, env);
  if (isRange(value)) {
    const { rows, cols } = rangeDims(value);
    /** @type {string[][]} */
    const grid = [];
    for (let r = 0; r < rows; r++) {
      const line = [];
      for (let c = 0; c < cols; c++) line.push(displayValue(value[r * cols + c] ?? null));
      grid.push(line);
    }
    return gfmTable(grid);
  }
  return escapeText(displayValue(value));
}

// -- pages ---------------------------------------------------------------------------------

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @param {MdEnv} env
 * @returns {string}
 */
function pageBody(ctx, page, env) {
  const content = ctx.data.pages[page.id]?.content;
  if (!content) return "";
  if (page.type === "document") {
    return (content.blockOrder ?? [])
      .map((/** @type {string} */ id) => (content.blocks[id] ? blockMarkdown(ctx, content.blocks[id], env) : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  if (page.type === "sheet") {
    const level = Math.min(6, env.titleLevel + 1);
    return (content.tableOrder ?? [])
      .map((/** @type {string} */ id) => {
        const table = content.tables[id];
        if (!table) return "";
        const grid = gfmTable(tableRows(table, ctx.engines));
        return `${"#".repeat(level)} ${oneLine(escapeText(table.name || "Table"))}${grid ? `\n\n${grid}` : ""}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (page.slidePaths.length > 0) {
    return (content.slideOrder ?? [])
      .map((/** @type {string} */ id, /** @type {number} */ index) => {
        const label = slideLabel(content.slides[id]);
        const href = encodeTarget(relativePath(env.fromPath, page.slidePaths[index]));
        return `- [Slide ${index + 1}${label ? `: ${escapeText(label)}` : ""}](${href})`;
      })
      .join("\n");
  }
  return (content.slideOrder ?? []).map((/** @type {string} */ id) => slideMarkdown(ctx, env, page.id, content, id)).join("\n\n");
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @param {MdFile} file
 * @param {number} titleLevel
 * @returns {string}
 */
function pageSection(ctx, page, file, titleLevel) {
  const env = { file, fromPath: page.path, containerId: page.id, content: ctx.data.pages[page.id]?.content, titleLevel, depth: 0 };
  const title = `${"#".repeat(titleLevel)} ${oneLine(escapeText(page.title || "Untitled"))}`;
  return [title, pageBody(ctx, page, env)].filter(Boolean).join("\n\n");
}

/**
 * One file per slide of a presentation exported with a sub-page per slide.
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @returns {MdOutput[]}
 */
function slideFiles(ctx, page) {
  const content = ctx.data.pages[page.id].content;
  const order = content.slideOrder ?? [];
  return order.map((/** @type {string} */ slideId, /** @type {number} */ index) => {
    const path = page.slidePaths[index];
    const file = newFile();
    const env = { file, fromPath: path, containerId: page.id, content, titleLevel: 1, depth: 0 };
    const link = (/** @type {string} */ text, /** @type {string} */ target) => `[${text}](${encodeTarget(relativePath(path, target))})`;
    const nav = [
      index > 0 ? link("Previous", page.slidePaths[index - 1]) : null,
      link("Overview", page.path),
      index < order.length - 1 ? link("Next", page.slidePaths[index + 1]) : null
    ].filter(Boolean);
    const title = `# ${oneLine(escapeText(page.title || "Untitled"))}: slide ${index + 1} of ${order.length}`;
    return { path, text: finish(file, [title, slideMarkdown(ctx, env, page.id, content, slideId), nav.join(" | ")].join("\n\n")) };
  });
}

/**
 * The overview of a multi-file export: every page, nested as in the sidebar.
 * @param {import("./context.js").ExportContext} ctx
 * @returns {MdOutput}
 */
function indexFile(ctx) {
  const path = /** @type {string} */ (ctx.plan.indexPath);
  const lines = ctx.plan.pages.map((page) => {
    const href = encodeTarget(relativePath(path, page.path));
    return `${"  ".repeat(page.depth)}- [${escapeText(page.title || "Untitled")}](${href})`;
  });
  return { path, text: `# ${oneLine(escapeText(ctx.workspace.title || "Workspace"))}\n\n${lines.join("\n")}\n` };
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @returns {MdOutput}
 */
function singleFile(ctx) {
  const { plan } = ctx;
  const file = newFile();
  const parts = [];
  if (plan.pages.length > 1) {
    parts.push(
      plan.pages
        .map((page) => `${"  ".repeat(page.depth)}- [${escapeText(page.title || "Untitled")}](#${page.anchor})`)
        .join("\n")
    );
  }
  for (const page of plan.pages) {
    const section = pageSection(ctx, page, file, Math.min(6, page.depth + 1));
    parts.push(plan.pages.length > 1 ? `<a id="${page.anchor}"></a>\n\n${section}` : section);
  }
  return { path: plan.singlePath, text: finish(file, parts.join("\n\n")) };
}

/**
 * Every file of a Markdown export.
 * @param {import("./context.js").ExportContext} ctx
 * @returns {MdOutput[]}
 */
export function exportMarkdown(ctx) {
  const { plan } = ctx;
  if (plan.request.layout === "single") return [singleFile(ctx)];
  /** @type {MdOutput[]} */
  const files = [];
  for (const page of plan.pages) {
    const file = newFile();
    files.push({ path: page.path, text: finish(file, pageSection(ctx, page, file, 1)) });
    if (page.slidePaths.length > 0) files.push(...slideFiles(ctx, page));
  }
  if (plan.indexPath) files.push(indexFile(ctx));
  return files;
}
