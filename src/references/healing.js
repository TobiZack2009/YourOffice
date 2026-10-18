/**
 * Keeping sections true to their content.
 *
 * Sections point at content by id, and ordinary commands (delete a block, delete a
 * table, drag a block elsewhere) know nothing about sections. So every command is
 * wrapped: `captureSections` notes what each section covers before the command, and
 * `healSections` afterwards
 *
 *  - re-fits a document section to the blocks of its run that survived (blocks added
 *    between its ends join it; blocks that left it are dropped from it);
 *  - moves content whose home vanished (every block of a run, a table, a slide) into the
 *    detached store, together with its sections, so readers keep working;
 *
 * The caller then sweeps the detached store, which drops whatever nothing reads.
 */

import { collectDescendants, findContainer } from "../document/model.js";
import { addDetached } from "./detached.js";
import { locatorSlideIds, sectionRunIds, slideLocator } from "./sections.js";

/**
 * @typedef {object} SectionCapture
 * @property {Map<string, Map<string, { runIds: string[], parentKey: string, blocks: Record<string, any> }>>} documents
 * @property {Map<string, Record<string, any>>} tables Sheet container id -> its tables (live objects, by id).
 * @property {Map<string, Record<string, any>>} slides Presentation container id -> slides that sections point at.
 */

/**
 * @param {{ blockId: string, itemId: string } | null} parent
 * @returns {string}
 */
function parentKey(parent) {
  return parent ? `${parent.blockId}:${parent.itemId}` : "";
}

/**
 * Note what sections cover. Cheap when the workspace has no sections and no tables.
 * @param {import("./containers.js").ContainerData} data
 * @returns {SectionCapture | null} Null when there is nothing to protect.
 */
export function captureSections(data) {
  /** @type {SectionCapture} */
  const capture = { documents: new Map(), tables: new Map(), slides: new Map() };
  let any = false;
  const containers = [...Object.entries(data.pages ?? {}), ...Object.entries(data.detached ?? {})];
  for (const [id, container] of containers) {
    const content = container?.content;
    if (!content) continue;
    const sections = Object.values(/** @type {Record<string, any>} */ (content.sections ?? {}));
    if (container.type === "sheet") {
      if (content.tables && Object.keys(content.tables).length > 0) {
        capture.tables.set(id, { ...content.tables });
        any = true;
      }
    } else if (container.type === "document" && sections.length > 0) {
      const perSection = new Map();
      for (const section of sections) {
        const runIds = sectionRunIds(content, section.locator);
        if (runIds.length === 0) continue;
        const where = findContainer(content, runIds[0]);
        /** @type {Record<string, any>} */
        const blocks = {};
        for (const blockId of runIds) {
          for (const member of [blockId, ...collectDescendants(content, blockId)]) blocks[member] = content.blocks[member];
        }
        perSection.set(section.id, { runIds, parentKey: parentKey(where?.parent ?? null), blocks });
      }
      if (perSection.size > 0) {
        capture.documents.set(id, perSection);
        any = true;
      }
    } else if (container.type === "presentation" && sections.length > 0) {
      /** @type {Record<string, any>} */
      const slides = {};
      for (const section of sections) {
        for (const slideId of locatorSlideIds(section.locator)) {
          const slide = content.slides?.[slideId];
          if (slide) slides[slide.id] = slide;
        }
      }
      if (Object.keys(slides).length > 0) {
        capture.slides.set(id, slides);
        any = true;
      }
    }
  }
  return any ? capture : null;
}

/**
 * Detach a vanished piece of content together with the sections that described it.
 * @param {import("./containers.js").ContainerData} data
 * @param {string} containerId Where it used to live.
 * @param {any} container
 * @param {"document" | "sheet" | "presentation"} type
 * @param {Record<string, any>} content
 * @param {any[]} sections Section records to carry along (removed from the live registry).
 */
function detach(data, containerId, container, type, content, sections) {
  /** @type {Record<string, any>} */
  const registry = {};
  for (const section of sections) {
    registry[section.id] = structuredClone(section);
    delete container.content.sections?.[section.id];
  }
  addDetached(data, {
    type,
    origin: { pageId: containerId, title: container.title ?? container.origin?.title ?? "" },
    content: structuredClone({ ...content, sections: registry })
  });
}

/**
 * Re-fit sections after a command and detach what vanished.
 * @param {import("./containers.js").ContainerData} data
 * @param {SectionCapture} capture
 * @param {(containerId: string) => void} touch Called for every container whose content changed.
 */
export function healSections(data, capture, touch) {
  const containerFor = (/** @type {string} */ id) => data.pages?.[id] ?? data.detached?.[id];

  for (const [containerId, perSection] of capture.documents) {
    const container = containerFor(containerId);
    if (!container?.content) continue;
    const content = container.content;
    for (const [sectionId, before] of perSection) {
      const section = content.sections?.[sectionId];
      if (!section) continue;
      /** @type {{ ids: string[], index: number }[]} */
      const survivors = [];
      /** @type {string[] | null} */
      let ids = null;
      for (const blockId of before.runIds) {
        if (!content.blocks[blockId]) continue;
        const where = findContainer(content, blockId);
        if (!where || parentKey(where.parent) !== before.parentKey) continue;
        ids ??= where.ids;
        if (where.ids === ids) survivors.push({ ids, index: where.index });
      }
      if (survivors.length === 0) {
        // The whole run is gone: keep it for whoever still reads it.
        detach(data, containerId, container, "document", {
          blockOrder: before.runIds.filter((id) => before.blocks[id]),
          blocks: before.blocks
        }, [section]);
        touch(containerId);
        continue;
      }
      const list = /** @type {string[]} */ (ids);
      const indexes = survivors.map((s) => s.index);
      const start = list[Math.min(...indexes)];
      const end = list[Math.max(...indexes)];
      if (section.locator.startBlockId !== start || section.locator.endBlockId !== end) {
        section.locator = { startBlockId: start, endBlockId: end };
        touch(containerId);
      }
    }
  }

  for (const [containerId, before] of capture.tables) {
    const container = containerFor(containerId);
    if (!container?.content) continue;
    for (const [tableId, table] of Object.entries(before)) {
      if (container.content.tables?.[tableId]) continue;
      const sections = Object.values(/** @type {Record<string, any>} */ (container.content.sections ?? {})).filter(
        (section) => section.locator?.tableId === tableId
      );
      detach(data, containerId, container, "sheet", { tables: { [tableId]: table }, tableOrder: [tableId] }, sections);
      touch(containerId);
    }
  }

  for (const [containerId, before] of capture.slides) {
    const container = containerFor(containerId);
    if (!container?.content) continue;
    const content = container.content;
    /** @type {{ ids: Set<string>, sections: any[] }[]} */
    const groups = [];
    for (const section of Object.values(/** @type {Record<string, any>} */ (content.sections ?? {}))) {
      const ids = locatorSlideIds(section.locator);
      const gone = ids.filter((id) => before[id] && !content.slides?.[id]);
      if (gone.length === 0) continue;
      const survivors = ids.filter((id) => content.slides?.[id]);
      if (survivors.length > 0) {
        // Some slides of the run remain: it shrinks to them.
        section.locator = slideLocator(survivors);
        touch(containerId);
        continue;
      }
      // Every slide is gone. Sections that shared a vanished slide share one detached copy.
      const sharing = groups.filter((group) => gone.some((id) => group.ids.has(id)));
      const group = sharing[0] ?? { ids: new Set(), sections: [] };
      if (!sharing[0]) groups.push(group);
      for (const other of sharing.slice(1)) {
        for (const id of other.ids) group.ids.add(id);
        group.sections.push(...other.sections);
        groups.splice(groups.indexOf(other), 1);
      }
      for (const id of gone) group.ids.add(id);
      group.sections.push(section);
    }
    for (const group of groups) {
      const slideIds = [...group.ids];
      detach(data, containerId, container, "presentation", {
        size: content.size,
        slideOrder: slideIds,
        slides: Object.fromEntries(slideIds.map((id) => [id, before[id]]))
      }, group.sections);
      touch(containerId);
    }
  }
}
