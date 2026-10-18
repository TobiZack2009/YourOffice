/**
 * The catalog: everything in the workspace that can be shown or read elsewhere,
 * laid out for a picker (pages in tree order, each with what it offers), and the
 * names an expression can currently use.
 *
 * Pure reads of workspace data, except `ensureSection`, which takes a workspace
 * and dispatches `createSection` for pieces that are not sections yet (tables,
 * slides and, once the user names them, runs of blocks).
 */

import { createId } from "../core/ids.js";
import { findSectionByLocator } from "./sections.js";
import { membersOf, scopeChain } from "./scope.js";
import { formatName, isPlainName } from "../sheet/names.js";

/**
 * @param {any[] | undefined} runs
 * @returns {string}
 */
function runsPlainText(runs) {
  return (runs ?? []).map((run) => (typeof run.text === "string" ? run.text : "")).join("");
}

/**
 * @typedef {object} CatalogItem
 * @property {string} key Unique within the catalog.
 * @property {"section" | "table" | "slide" | "block"} kind
 * @property {string} label
 * @property {string} pageId Page that holds it.
 * @property {string} [sectionId] Existing section (named or implicit).
 * @property {string} [name] Section name, when named.
 * @property {Record<string, any>} [locator] What a new section would cover.
 */

/**
 * @typedef {object} CatalogPage
 * @property {string} pageId
 * @property {string} title
 * @property {"document" | "sheet" | "presentation"} type
 * @property {number} depth
 * @property {CatalogItem[]} items
 */

/**
 * @param {any} block
 * @returns {string}
 */
function blockLabel(block) {
  const text =
    block.type === "code"
      ? (block.text ?? "")
      : block.type === "list"
        ? (block.items ?? []).map((/** @type {any} */ item) => runsPlainText(item.runs)).join(" ")
        : runsPlainText(block.runs);
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed) return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
  return block.type === "divider" ? "Divider" : block.type === "image" ? "Image" : "Empty block";
}

/**
 * @param {any} data Workspace data.
 * @param {any} page
 * @returns {CatalogItem[]}
 */
function itemsOf(data, page) {
  /** @type {CatalogItem[]} */
  const items = [];
  const content = page.content ?? {};
  const sections = Object.values(content.sections ?? {}).map((s) => /** @type {any} */ (s));
  const named = sections.filter((section) => typeof section.name === "string" && section.name !== "");

  if (page.type === "sheet") {
    for (const tableId of content.tableOrder ?? []) {
      const table = content.tables?.[tableId];
      if (!table) continue;
      const whole = sections.find((s) => s.locator.tableId === tableId && !s.locator.range);
      items.push({
        key: `table:${tableId}`,
        kind: "table",
        label: table.name,
        pageId: page.id,
        ...(whole ? { sectionId: whole.id } : {}),
        locator: { tableId }
      });
    }
    for (const section of named.filter((s) => s.locator.range)) {
      items.push({ key: `section:${section.id}`, kind: "section", label: section.name, name: section.name, pageId: page.id, sectionId: section.id });
    }
  } else if (page.type === "presentation") {
    (content.slideOrder ?? []).forEach((/** @type {string} */ slideId, /** @type {number} */ index) => {
      const section = sections.find((s) => s.locator.slideId === slideId);
      const name = section?.name;
      items.push({
        key: `slide:${slideId}`,
        kind: "slide",
        label: name ? `Slide ${index + 1}: ${name}` : `Slide ${index + 1}`,
        pageId: page.id,
        ...(section ? { sectionId: section.id } : {}),
        ...(name ? { name } : {}),
        locator: { slideId }
      });
    });
  } else {
    for (const section of named) {
      items.push({ key: `section:${section.id}`, kind: "section", label: section.name, name: section.name, pageId: page.id, sectionId: section.id });
    }
    for (const id of content.blockOrder ?? []) {
      const block = content.blocks?.[id];
      if (!block || block.type === "sectionRef") continue;
      items.push({ key: `block:${id}`, kind: "block", label: blockLabel(block), pageId: page.id, locator: { startBlockId: id, endBlockId: id } });
    }
  }
  return items;
}

/**
 * Pages in tree order with what each offers.
 * @param {any} data Workspace data.
 * @returns {CatalogPage[]}
 */
export function buildCatalog(data) {
  /** @type {CatalogPage[]} */
  const pages = [];
  /** @param {string} id @param {number} depth */
  const visit = (id, depth) => {
    const page = data.pages[id];
    if (!page) return;
    pages.push({ pageId: id, title: page.title || "Untitled", type: page.type, depth, items: itemsOf(data, page) });
    for (const child of data.pageOrder?.[id] ?? []) visit(child, depth + 1);
  };
  for (const id of data.pageOrder?.root ?? []) visit(id, 0);
  return pages;
}

/**
 * Narrow a catalog by a search string: a page stays when its title or any item matches.
 * @param {CatalogPage[]} pages
 * @param {string} query
 * @returns {CatalogPage[]}
 */
export function filterCatalog(pages, query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return pages;
  /** @type {CatalogPage[]} */
  const out = [];
  for (const page of pages) {
    const pageHit = page.title.toLowerCase().includes(needle);
    const items = pageHit ? page.items : page.items.filter((item) => item.label.toLowerCase().includes(needle));
    if (pageHit || items.length > 0) out.push({ ...page, items });
  }
  return out;
}

/**
 * The section id behind a catalog item, creating an implicit (unnamed) section for a
 * table or slide that has none, or a named one for a block run.
 * @param {{ data: any, transact: Function, dispatch: Function }} workspace
 * @param {CatalogItem} item
 * @param {string} [name] Required for `block` items.
 * @returns {string}
 */
export function ensureSection(workspace, item, name) {
  if (item.sectionId) return item.sectionId;
  const page = workspace.data.pages[item.pageId];
  const existing = findSectionByLocator(page, item.locator);
  if (existing && (item.kind !== "block" || !name)) return existing.id;
  const sectionId = createId("section");
  workspace.dispatch("createSection", {
    pageId: item.pageId,
    sectionId,
    locator: item.locator,
    ...(item.kind === "block" ? { name: name || "Section" } : { implicit: true })
  });
  return sectionId;
}

/**
 * Names an expression written on a page can use, innermost scope first, filtered by prefix.
 * Each is already spelled the way it must be written (quoted when it needs to be).
 * @param {any} data
 * @param {string} containerId
 * @param {string} [prefix]
 * @returns {{ text: string, kind: "table" | "section" | "page" }[]}
 */
export function suggestNames(data, containerId, prefix = "") {
  const needle = prefix.toLowerCase().replace(/^'/, "");
  /** @type {{ text: string, kind: "table" | "section" | "page" }[]} */
  const out = [];
  const seen = new Set();
  const pageId = data.pages[containerId] ? containerId : (data.detached?.[containerId]?.origin?.pageId ?? containerId);
  for (const scope of scopeChain(data, pageId)) {
    for (const member of membersOf(data, scope)) {
      if (!member.name.toLowerCase().startsWith(needle)) continue;
      const text = isPlainName(member.name) ? member.name : formatName(member.name);
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({ text, kind: member.kind });
    }
  }
  return out;
}
