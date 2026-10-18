/**
 * The detached store: content that lost its place but is still read.
 *
 * When a section's source is deleted (its blocks, table or slide, or the whole page) while
 * something still reads it (an embed, an expression or a cell formula), the content moves into
 * `data.detached[id]` in the same transaction. A detached entry looks like a page envelope
 *
 *   { id, type, title, createdAt, modifiedAt, origin: { pageId, title }, content }
 *
 * and its content has the same shape as page content, including its own `sections` registry, so
 * every reader (renderers, the formula engine, name resolution) treats it as one more container.
 * Names keep resolving through `origin.pageId` while that page lives.
 *
 * An entry is discarded as soon as nothing reachable from a live page reads it any more
 * (`sweepDetached`); that happens inside the transaction that removed the last reader, so
 * undo brings it back with the rest.
 */

import { createId } from "../core/ids.js";
import { collectDescendants } from "../document/model.js";
import { createTable } from "../sheet/model.js";
import { collectReferenceSites } from "./index.js";

/** @typedef {import("./containers.js").ContainerData} ContainerData */

/**
 * Create a detached entry.
 * @param {ContainerData} data
 * @param {{ type: "document" | "sheet" | "presentation", origin: { pageId: string, title?: string }, content: Record<string, any> }} spec
 * @returns {string} The new entry's id.
 */
export function addDetached(data, spec) {
  const target = /** @type {Record<string, any>} */ (data);
  target.detached ??= {};
  const id = createId("detached");
  const now = new Date().toISOString();
  target.detached[id] = {
    id,
    type: spec.type,
    title: "",
    createdAt: now,
    modifiedAt: now,
    origin: { pageId: spec.origin.pageId, title: spec.origin.title ?? "" },
    content: spec.content
  };
  return id;
}

/**
 * Drop every detached entry that nothing reachable from a live page reads.
 * @param {ContainerData} data
 * @returns {string[]} Ids of the discarded entries.
 */
export function sweepDetached(data) {
  const detached = /** @type {Record<string, any> | undefined} */ (data.detached);
  if (!detached || Object.keys(detached).length === 0) return [];

  const sites = collectReferenceSites(/** @type {any} */ (data));
  /** @type {Set<string>} */
  const reachable = new Set(Object.keys(data.pages));
  let grew = true;
  while (grew) {
    grew = false;
    for (const site of sites) {
      if (!reachable.has(site.containerId)) continue;
      for (const target of site.targets) {
        if (detached[target.containerId] && !reachable.has(target.containerId)) {
          reachable.add(target.containerId);
          grew = true;
        }
      }
    }
  }
  /** @type {string[]} */
  const dropped = [];
  for (const id of Object.keys(detached)) {
    if (!reachable.has(id)) {
      delete detached[id];
      dropped.push(id);
    }
  }
  return dropped;
}

// -- copies --------------------------------------------------------------------------

/**
 * Content for a detached entry that copies a section's material, leaving the source alone
 * ("stop sharing": the section id moves to the copy so every reader keeps its view).
 * @param {any} container Page or detached entry holding the section.
 * @param {any} section
 * @returns {Record<string, any> | null} Null when the section no longer describes real content.
 */
export function copySectionContent(container, section) {
  const content = container.content;
  const { id, name, implicit, locator } = section;
  /** @param {any} locatorCopy */
  const registry = (locatorCopy) => ({ [id]: { id, ...(name ? { name } : {}), ...(implicit ? { implicit } : {}), locator: locatorCopy } });

  if (container.type === "document") {
    const ids = [];
    let at = content.blockOrder.indexOf(locator.startBlockId);
    const parentIds = at !== -1 ? content.blockOrder : null;
    if (parentIds) {
      const end = parentIds.indexOf(locator.endBlockId);
      for (let i = at; i <= end; i++) ids.push(parentIds[i]);
    }
    if (ids.length === 0) return null;
    const blocks = {};
    for (const blockId of ids) {
      for (const copied of [blockId, ...collectDescendants(content, blockId)]) {
        blocks[copied] = structuredClone(content.blocks[copied]);
      }
    }
    return {
      blockOrder: ids,
      blocks,
      sections: registry({ startBlockId: ids[0], endBlockId: ids[ids.length - 1] })
    };
  }
  if (container.type === "presentation") {
    const slide = content.slides?.[locator.slideId];
    if (!slide) return null;
    return {
      size: structuredClone(content.size),
      slideOrder: [slide.id],
      slides: { [slide.id]: structuredClone(slide) },
      sections: registry({ slideId: slide.id })
    };
  }
  const table = content.tables?.[locator.tableId];
  if (!table) return null;
  const copy = structuredClone(table);
  copy.id = createTable().id;
  return {
    tables: { [copy.id]: copy },
    tableOrder: [copy.id],
    sections: registry({ ...structuredClone(locator), tableId: copy.id })
  };
}

// -- restoring -----------------------------------------------------------------------

/**
 * Give every id in `taken` that collides a fresh one inside a block set (and the section locators).
 * @param {Record<string, any>} content Detached document content, mutated.
 * @param {Record<string, any>} into Target document content.
 */
function remapBlocks(content, into) {
  /** @type {Map<string, string>} */
  const renamed = new Map();
  for (const id of Object.keys(content.blocks)) {
    if (into.blocks[id]) renamed.set(id, createId("block"));
  }
  if (renamed.size === 0) return;
  /** @type {Record<string, any>} */
  const blocks = {};
  for (const [id, block] of Object.entries(content.blocks)) {
    const next = renamed.get(id) ?? id;
    blocks[next] = { ...block, id: next };
    for (const item of blocks[next].items ?? []) {
      if (Array.isArray(item.children)) item.children = item.children.map((/** @type {string} */ c) => renamed.get(c) ?? c);
    }
  }
  content.blocks = blocks;
  content.blockOrder = content.blockOrder.map((/** @type {string} */ id) => renamed.get(id) ?? id);
  for (const section of Object.values(/** @type {Record<string, any>} */ (content.sections ?? {}))) {
    section.locator.startBlockId = renamed.get(section.locator.startBlockId) ?? section.locator.startBlockId;
    section.locator.endBlockId = renamed.get(section.locator.endBlockId) ?? section.locator.endBlockId;
  }
}

/**
 * Move a detached entry's material back into a live page of the same type and delete the entry.
 * The sections keep their ids, so every reader carries on without being touched.
 * @param {ContainerData} data
 * @param {string} detachedId
 * @param {string} pageId
 * @param {(desired: string, exceptId: string) => string} uniqueSectionName Resolves name clashes on the page.
 */
export function restoreInto(data, detachedId, pageId, uniqueSectionName) {
  const entry = /** @type {Record<string, any>} */ (data.detached ?? {})[detachedId];
  const page = data.pages[pageId];
  if (!entry || !page) return;
  const content = entry.content;
  const into = (page.content ??= {});
  if (entry.type === "document") {
    into.blockOrder ??= [];
    into.blocks ??= {};
    remapBlocks(content, into);
    Object.assign(into.blocks, content.blocks);
    into.blockOrder.push(...content.blockOrder);
  } else if (entry.type === "presentation") {
    into.slideOrder ??= [];
    into.slides ??= {};
    Object.assign(into.slides, content.slides);
    into.slideOrder.push(...content.slideOrder);
  } else {
    into.tables ??= {};
    into.tableOrder ??= [];
    Object.assign(into.tables, content.tables);
    into.tableOrder.push(...content.tableOrder);
  }
  into.sections ??= {};
  for (const section of Object.values(/** @type {Record<string, any>} */ (content.sections ?? {}))) {
    if (section.name) section.name = uniqueSectionName(section.name, section.id);
    into.sections[section.id] = section;
  }
  delete (/** @type {Record<string, any>} */ (data.detached))[detachedId];
}
