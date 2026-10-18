/**
 * Sections: named, contiguous pieces of one container that other places can show.
 *
 * A section is `{ id, name?, locator, implicit? }` in `content.sections` of the
 * container it lives in (a page, or a detached entry). The locator is typed by
 * the container's page type:
 *
 *   document      { startBlockId, endBlockId }   a run of sibling blocks
 *   sheet         { tableId, range? }            a whole table, or a 0-based rectangle of it
 *   presentation  { slideId }                    one whole slide
 *
 * `implicit` sections have no name and exist so that every embed goes through a
 * section, even of a table or slide nobody named.
 *
 * Everything here is pure: it reads plain workspace data and never mutates it.
 */

import { allContainers } from "./containers.js";
import { findContainer, collectDescendants } from "../document/model.js";

/**
 * @typedef {object} FoundSection
 * @property {string} containerId Page id or detached id holding the section.
 * @property {any} container The page envelope or detached entry.
 * @property {any} section
 * @property {boolean} detached
 */

/**
 * @param {import("./containers.js").ContainerData} data
 * @param {string} sectionId
 * @returns {FoundSection | null}
 */
export function findSection(data, sectionId) {
  for (const [containerId, container] of allContainers(data)) {
    const section = container?.content?.sections?.[sectionId];
    if (section) return { containerId, container, section, detached: !data.pages[containerId] };
  }
  return null;
}

/**
 * Block ids of a document section's run, in order (top-level of the run only).
 * Empty when the boundary blocks are missing or no longer siblings.
 * @param {any} content Document content.
 * @param {{ startBlockId: string, endBlockId: string }} locator
 * @returns {string[]}
 */
export function sectionRunIds(content, locator) {
  const start = findContainer(content, locator.startBlockId);
  if (!start) return [];
  const end = start.ids.indexOf(locator.endBlockId);
  if (end < start.index) return [];
  return start.ids.slice(start.index, end + 1);
}

/**
 * Every block id covered by a document section: the run and everything nested in it.
 * @param {any} content
 * @param {{ startBlockId: string, endBlockId: string }} locator
 * @returns {string[]}
 */
export function sectionBlockIds(content, locator) {
  return sectionRunIds(content, locator).flatMap((id) => [id, ...collectDescendants(content, id)]);
}

/**
 * The sections of a container whose content includes a given item: a block (and
 * its descendants), a slide, or a table.
 * @param {any} container Page or detached entry.
 * @param {{ blockId?: string, slideId?: string, tableId?: string }} item
 * @returns {any[]}
 */
export function sectionsCovering(container, item) {
  const sections = Object.values(container?.content?.sections ?? {});
  if (container?.type === "document" && item.blockId) {
    return sections.filter((section) =>
      sectionBlockIds(container.content, /** @type {any} */ (section).locator).includes(/** @type {string} */ (item.blockId))
    );
  }
  if (container?.type === "presentation" && item.slideId) {
    return sections.filter((section) => /** @type {any} */ (section).locator.slideId === item.slideId);
  }
  if (container?.type === "sheet" && item.tableId) {
    return sections.filter((section) => /** @type {any} */ (section).locator.tableId === item.tableId);
  }
  return [];
}

/**
 * Plain text of a section, for coercion in expressions (`&`, comparisons, `INCLUDES`).
 * Blocks are joined by newlines; embedded references contribute their own text, up
 * to a depth limit that stops runaway cycles.
 * @param {import("./containers.js").ContainerData} data
 * @param {string} sectionId
 * @param {number} [depth]
 * @returns {string | null} Null when the section is missing or too deeply nested.
 */
export function sectionPlainText(data, sectionId, depth = 0) {
  if (depth > 8) return null;
  const found = findSection(data, sectionId);
  if (!found) return null;
  const { container, section } = found;
  if (container.type === "document") {
    const lines = [];
    for (const id of sectionRunIds(container.content, section.locator)) {
      const block = container.content.blocks[id];
      if (block) lines.push(blockPlainText(data, container.content, block, depth));
    }
    return lines.join("\n");
  }
  if (container.type === "presentation") {
    const slide = container.content.slides?.[section.locator.slideId];
    if (!slide) return "";
    return (slide.objectOrder ?? [])
      .map((id) => slide.objects[id])
      .filter((object) => object?.type === "text")
      .map((object) => runsText(data, object.text?.runs ?? [], depth))
      .join("\n");
  }
  return null;
}

/**
 * @param {import("./containers.js").ContainerData} data
 * @param {any} content
 * @param {any} block
 * @param {number} depth
 * @returns {string}
 */
function blockPlainText(data, content, block, depth) {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "quote":
      return runsText(data, block.runs ?? [], depth);
    case "code":
      return block.text ?? "";
    case "list":
      return (block.items ?? [])
        .map((/** @type {any} */ item) =>
          [runsText(data, item.runs ?? [], depth), ...(item.children ?? []).map((/** @type {string} */ id) => {
            const child = content.blocks[id];
            return child ? blockPlainText(data, content, child, depth) : "";
          })].join("\n")
        )
        .join("\n");
    case "sectionRef":
      return block.kind === "expression" ? "" : (sectionPlainText(data, block.sectionId, depth + 1) ?? "");
    default:
      return "";
  }
}

/**
 * @param {import("./containers.js").ContainerData} data
 * @param {any[]} runs
 * @param {number} depth
 * @returns {string}
 */
function runsText(data, runs, depth) {
  return runs
    .map((run) =>
      typeof run.text === "string"
        ? run.text
        : run.ref && run.ref.kind !== "expression"
          ? (sectionPlainText(data, run.ref.sectionId, depth + 1) ?? "")
          : ""
    )
    .join("");
}

/**
 * Which kind of content a section holds.
 * @param {FoundSection} found
 * @returns {"blocks" | "table" | "slide"}
 */
export function sectionKind(found) {
  if (found.container.type === "sheet") return "table";
  return found.container.type === "presentation" ? "slide" : "blocks";
}

/**
 * Whether a container's section registry still describes real content.
 * @param {any} container
 * @param {any} section
 * @returns {boolean}
 */
export function sectionIsIntact(container, section) {
  const content = container?.content;
  if (!content) return false;
  if (container.type === "document") return sectionRunIds(content, section.locator).length > 0;
  if (container.type === "presentation") return Boolean(content.slides?.[section.locator.slideId]);
  return Boolean(content.tables?.[section.locator.tableId]);
}

/**
 * Why a locator does not describe real content in a container, or null when it does.
 * @param {any} container Page or detached entry.
 * @param {any} locator
 * @returns {string | null}
 */
export function locatorProblem(container, locator) {
  const content = container?.content;
  if (!content || !locator || typeof locator !== "object") return "A section needs a location.";
  if (container.type === "document") {
    const start = typeof locator.startBlockId === "string" ? findContainer(content, locator.startBlockId) : null;
    if (!start || !content.blocks?.[locator.startBlockId]) return "The first block of the section does not exist.";
    const end = start.ids.indexOf(locator.endBlockId);
    if (end === -1) return "A section must be a run of neighbouring blocks.";
    if (end < start.index) return "The section ends before it starts.";
    return null;
  }
  if (container.type === "presentation") {
    return content.slides?.[locator.slideId] ? null : "That slide does not exist.";
  }
  const table = content.tables?.[locator.tableId];
  if (!table) return "That table does not exist.";
  if (locator.range !== undefined) {
    const { start, end } = locator.range ?? {};
    const ok = [start?.col, start?.row, end?.col, end?.row].every((n) => Number.isInteger(n) && n >= 0);
    if (!ok || start.col > end.col || start.row > end.row) return "That range is not valid.";
  }
  return null;
}

/**
 * The section of a container with exactly this locator, if any (used to reuse implicit sections).
 * @param {any} container
 * @param {any} locator
 * @returns {any | null}
 */
export function findSectionByLocator(container, locator) {
  const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);
  for (const section of Object.values(container?.content?.sections ?? {})) {
    if (same(/** @type {any} */ (section).locator, locator)) return section;
  }
  return null;
}
