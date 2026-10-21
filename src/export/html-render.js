/**
 * Pages as HTML: a self-contained file per page (or one file for all), each carrying the
 * stylesheet it needs, with images as `data:` addresses and slides as inline SVG.
 *
 * Documents are drawn by the same renderer the app uses and then made plain: editor
 * attributes removed, links between exported pages rewritten to where those pages now live.
 */

import { renderDocument } from "../document/render.js";
import { pageOfLink } from "./plan.js";
import { staticContext, slideLabel } from "./context.js";
import { tableRows } from "./csv.js";
import { escapeHtml } from "./encode.js";
import { relativePath } from "./names.js";
import { slideSvgElement } from "./slide-svg-render.js";
import { elementFactory, staticReferenceHooks } from "./static-render.js";
import { PAGE_CSS } from "./styles.js";

/** Attributes the editor needs and a reader does not. */
const EDITOR_ATTRIBUTES = ["data-block-id", "data-block-type", "data-item-id", "data-ref", "data-ref-id", "contenteditable"];

/**
 * @typedef {{ path: string, text: string }} HtmlOutput
 */

/**
 * @param {import("./context.js").ExportContext} ctx
 * @returns {Document}
 */
function documentOf(ctx) {
  if (!ctx.document) throw new Error("HTML export needs a DOM: pass `env.document`.");
  return ctx.document;
}

/**
 * Headings of a page's content sit below the page's own title.
 * @param {Element} root
 * @param {number} titleLevel
 * @param {Document} doc
 */
function shiftHeadings(root, titleLevel, doc) {
  for (const heading of [...root.querySelectorAll("h1,h2,h3")]) {
    const level = Math.min(6, titleLevel + Number(heading.tagName.slice(1)));
    const replacement = doc.createElement(`h${level}`);
    for (const attr of [...heading.attributes]) replacement.setAttribute(attr.name, attr.value);
    replacement.append(...heading.childNodes);
    heading.replaceWith(replacement);
  }
}

/**
 * Point links at the exported pages, and drop the link of a page that is not exported.
 * @param {Element} root
 * @param {import("./context.js").ExportContext} ctx
 * @param {string} fromPath
 */
function fixLinks(root, ctx, fromPath) {
  for (const anchor of [...root.querySelectorAll("a[href]")]) {
    const href = anchor.getAttribute("href") ?? "";
    const pageId = pageOfLink(ctx.data, href);
    if (pageId) {
      const target = ctx.hrefFor(fromPath, pageId);
      if (target) anchor.setAttribute("href", target);
      else anchor.replaceWith(...anchor.childNodes);
    } else if (/^https?:/i.test(href)) {
      anchor.setAttribute("rel", "noopener noreferrer");
    }
  }
}

/**
 * @param {Element} root
 * @param {import("./context.js").ExportContext} ctx
 */
function cleanEditorMarkup(root, ctx) {
  for (const figure of root.querySelectorAll("figure[data-missing-asset]")) {
    ctx.warnings.push(`An image is missing from the workspace${figure.textContent ? ` ("${figure.textContent}")` : ""}.`);
    figure.removeAttribute("data-missing-asset");
  }
  for (const attribute of EDITOR_ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) element.removeAttribute(attribute);
  }
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @param {string} fromPath
 * @param {number} titleLevel
 * @returns {Element}
 */
function documentBody(ctx, page, fromPath, titleLevel) {
  const doc = documentOf(ctx);
  const sctx = staticContext(ctx);
  const article = renderDocument(ctx.data.pages[page.id].content, {
    document: doc,
    resolvePageTitle: ctx.titleOf,
    ...staticReferenceHooks(sctx, page.id, 0)
  });
  shiftHeadings(article, titleLevel, doc);
  fixLinks(article, ctx, fromPath);
  cleanEditorMarkup(article, ctx);
  return article;
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @param {number} titleLevel
 * @returns {Element}
 */
function sheetBody(ctx, page, titleLevel) {
  const h = elementFactory(ctx.document);
  const content = ctx.data.pages[page.id].content;
  const wrap = h("div", { class: "export-sheet" });
  for (const id of content.tableOrder ?? []) {
    const table = content.tables[id];
    if (!table) continue;
    const rows = tableRows(table, ctx.engines);
    wrap.append(h(`h${Math.min(6, titleLevel + 1)}`, { text: table.name || "Table" }));
    if (rows.length === 0) {
      wrap.append(h("p", { class: "reference-missing", text: "This table is empty." }));
      continue;
    }
    const body = h("tbody");
    for (const row of rows) body.append(h("tr", {}, row.map((text) => h("td", { text }))));
    wrap.append(h("table", { class: "export-table" }, [body]));
  }
  return wrap;
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {string} pageId
 * @param {string} slideId
 * @param {number} number 1-based position of the slide.
 * @returns {Element}
 */
function slideFigure(ctx, pageId, slideId, number) {
  const h = elementFactory(ctx.document);
  const drawn = slideSvgElement(ctx, pageId, slideId);
  const label = slideLabel(ctx.data.pages[pageId].content.slides[slideId]);
  return h("figure", {}, [drawn?.element, h("figcaption", { text: `Slide ${number}${label ? `: ${label}` : ""}` })]);
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @param {string} fromPath
 * @returns {Element}
 */
function presentationBody(ctx, page, fromPath) {
  const h = elementFactory(ctx.document);
  const content = ctx.data.pages[page.id].content;
  const order = /** @type {string[]} */ (content.slideOrder ?? []);
  if (page.slidePaths.length > 0) {
    const items = order.map((id, index) => {
      const label = slideLabel(content.slides[id]);
      return h("li", {}, [h("a", { href: relativePath(fromPath, page.slidePaths[index]), text: `Slide ${index + 1}${label ? `: ${label}` : ""}` })]);
    });
    return h("ol", { class: "export-slide-list" }, items);
  }
  return h("div", { class: "export-slides" }, order.map((id, index) => slideFigure(ctx, page.id, id, index + 1)));
}

/**
 * One page as an `<article>`.
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @param {string} fromPath File the article is written to.
 * @param {number} titleLevel
 * @returns {Element}
 */
function pageArticle(ctx, page, fromPath, titleLevel) {
  const h = elementFactory(ctx.document);
  const title = h(`h${titleLevel}`, { class: "page-title", text: page.title || "Untitled" });
  let body;
  if (!ctx.data.pages[page.id]?.content) body = null;
  else if (page.type === "document") body = documentBody(ctx, page, fromPath, titleLevel);
  else if (page.type === "sheet") body = sheetBody(ctx, page, titleLevel);
  else body = presentationBody(ctx, page, fromPath);
  return h("article", { class: "export-page", id: page.anchor }, [title, body]);
}

/**
 * Nested lists from a flat list with depths.
 * @param {{ depth: number, html: string }[]} items
 * @returns {string}
 */
function nestedList(items) {
  let out = "<ul>";
  let current = 0;
  items.forEach((item, index) => {
    const depth = Math.min(item.depth, current + 1);
    if (index > 0) {
      if (depth > current) out += "<ul>";
      else {
        out += "</li>";
        for (let d = current; d > depth; d--) out += "</ul></li>";
      }
    }
    out += `<li>${item.html}`;
    current = depth;
  });
  out += "</li>";
  for (let d = current; d > 0; d--) out += "</ul></li>";
  return `${out}</ul>`;
}

/**
 * @param {{ title: string, nav?: string, body: string, bodyAttributes?: string }} parts
 * @returns {string}
 */
function shell({ title, nav = "", body, bodyAttributes = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body${bodyAttributes}>
${nav}<main>
${body}
</main>
</body>
</html>
`;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} text
 * @returns {string}
 */
function link(from, to, text) {
  return `<a href="${escapeHtml(relativePath(from, to))}">${escapeHtml(text)}</a>`;
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {string} fromPath
 * @returns {string}
 */
function indexNav(ctx, fromPath) {
  return ctx.plan.indexPath ? `<nav class="export-nav">${link(fromPath, ctx.plan.indexPath, "All pages")}</nav>\n` : "";
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @param {import("./plan.js").PlanPage} page
 * @returns {HtmlOutput[]}
 */
function slideFiles(ctx, page) {
  const h = elementFactory(ctx.document);
  const order = /** @type {string[]} */ (ctx.data.pages[page.id].content.slideOrder ?? []);
  return order.map((slideId, index) => {
    const path = page.slidePaths[index];
    const nav = [
      index > 0 ? link(path, page.slidePaths[index - 1], "Previous") : "",
      link(path, page.path, page.title || "Untitled"),
      index < order.length - 1 ? link(path, page.slidePaths[index + 1], "Next") : ""
    ].join("");
    const holder = h("div", { class: "export-slides" }, [slideFigure(ctx, page.id, slideId, index + 1)]);
    return {
      path,
      text: shell({
        title: `${page.title || "Untitled"}: slide ${index + 1}`,
        nav: `<nav class="export-nav">${nav}</nav>\n`,
        body: `<article class="export-page">${holder.outerHTML}</article>`
      })
    };
  });
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @returns {HtmlOutput}
 */
function indexFile(ctx) {
  const path = /** @type {string} */ (ctx.plan.indexPath);
  const items = ctx.plan.pages.map((page) => ({ depth: page.depth, html: link(path, page.path, page.title || "Untitled") }));
  const title = ctx.workspace.title || "Workspace";
  return {
    path,
    text: shell({ title, body: `<h1 class="page-title">${escapeHtml(title)}</h1>\n<nav class="export-index">${nestedList(items)}</nav>` })
  };
}

/**
 * @param {import("./context.js").ExportContext} ctx
 * @returns {HtmlOutput}
 */
function singleFile(ctx) {
  const { plan } = ctx;
  const many = plan.pages.length > 1;
  const articles = plan.pages.map((page) => pageArticle(ctx, page, plan.singlePath, Math.min(6, page.depth + 1)).outerHTML);
  const toc = many
    ? `<nav class="export-toc">${nestedList(plan.pages.map((page) => ({ depth: page.depth, html: `<a href="#${escapeHtml(page.anchor)}">${escapeHtml(page.title || "Untitled")}</a>` })))}</nav>\n`
    : "";
  const title = many ? ctx.workspace.title || "Export" : plan.pages[0]?.title || "Untitled";
  return {
    path: plan.singlePath,
    text: shell({
      title,
      body: toc + articles.join("\n"),
      bodyAttributes: many && plan.request.sectionStyle === "target" ? ' data-sections="target"' : ""
    })
  };
}

/**
 * Every file of an HTML export.
 * @param {import("./context.js").ExportContext} ctx
 * @returns {HtmlOutput[]}
 */
export function exportHtml(ctx) {
  documentOf(ctx);
  const { plan } = ctx;
  if (plan.request.layout === "single") return [singleFile(ctx)];
  /** @type {HtmlOutput[]} */
  const files = [];
  for (const page of plan.pages) {
    files.push({
      path: page.path,
      text: shell({
        title: page.title || "Untitled",
        nav: indexNav(ctx, page.path),
        body: pageArticle(ctx, page, page.path, 1).outerHTML
      })
    });
    if (page.slidePaths.length > 0) files.push(...slideFiles(ctx, page));
  }
  if (plan.indexPath) files.push(indexFile(ctx));
  return files;
}
