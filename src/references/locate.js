/**
 * Turn a name or `Page!Table!B2` path into the cells it points at.
 *
 * Pure: it reads the workspace data and answers with 1-based engine positions in
 * the target table's own coordinate space. The recalculation engine uses it to
 * build dependencies and to read values; later layers add sections.
 */

import { ERR, withDetail } from "../calc/errors.js";
import { resolveTarget } from "./scope.js";
import { containerOf, allContainers } from "./containers.js";
import { findSection } from "./sections.js";

/** @typedef {{ col: number, row: number }} Position */
/**
 * @typedef {object} Located
 * @property {import("../calc/errors.js").FormulaError} [error]
 * @property {{ tableId: string, start: Position, end: Position, scalar: boolean }} [cells]
 * @property {import("../calc/values.js").Value} [value] A ready value (a handle to blocks or a slide).
 */

/**
 * @param {{ pages: Record<string, any>, pageOrder: Record<string, string[]> }} data
 * @param {string | null} fromPageId Page whose scope the name is read in.
 * @param {string[]} segments
 * @param {{ type: string, [key: string]: any } | null} address Trailing cell or range node.
 * @returns {Located}
 */
export function locateReference(data, fromPageId, segments, address) {
  const resolved = resolveTarget(data, fromPageId, segments);
  if (!resolved.target) return { error: resolved.error ?? ERR.NAME };
  return locateTarget(data, resolved.target, address, segments.join("!"));
}

/**
 * Locate an already-resolved target.
 * @param {{ pages: Record<string, any>, pageOrder: Record<string, string[]> }} data
 * @param {import("./scope.js").Target} target
 * @param {{ type: string, [key: string]: any } | null} address
 * @param {string} label Name used in messages.
 * @returns {Located}
 */
export function locateTarget(data, target, address, label) {
  if (target.kind === "page") {
    return { error: withDetail(ERR.VALUE, `"${label}" is a page, not a table; name a table or section inside it.`) };
  }

  /** @type {string} */
  let tableId = /** @type {string} */ (target.tableId);
  /** @type {{ start: {col:number,row:number}, end: {col:number,row:number} } | null} */
  let window = null;
  if (target.kind === "section") {
    const section = containerOf(data, target.pageId)?.content?.sections?.[/** @type {string} */ (target.sectionId)];
    if (!section) return { error: withDetail(ERR.REF, `The section "${label}" no longer exists.`) };
    const type = containerOf(data, target.pageId)?.type;
    if (type !== "sheet") {
      if (address) {
        return { error: withDetail(ERR.VALUE, `"${label}" is a section; it has no cell addresses.`) };
      }
      return { value: { kind: type === "presentation" ? "slide" : "blocks", sectionId: section.id } };
    }
    tableId = section.locator.tableId;
    if (section.locator.range) {
      const r = section.locator.range;
      window = {
        start: { col: Math.min(r.start.col, r.end.col) + 1, row: Math.min(r.start.row, r.end.row) + 1 },
        end: { col: Math.max(r.start.col, r.end.col) + 1, row: Math.max(r.start.row, r.end.row) + 1 }
      };
    }
  }

  const table = containerOf(data, target.pageId)?.content?.tables?.[tableId];
  if (!table) return { error: withDetail(ERR.REF, `The table "${label}" no longer exists.`) };

  // A range section reads like a small table of its own: addresses are relative to its corner.
  const origin = window ? window.start : { col: 1, row: 1 };
  const shifted = (/** @type {{col:number,row:number}} */ p) => ({ col: p.col + origin.col - 1, row: p.row + origin.row - 1 });
  if (!address) {
    return {
      cells: {
        tableId,
        start: window ? window.start : { col: 1, row: 1 },
        end: window ? window.end : { col: Math.max(1, table.columnCount), row: Math.max(1, table.rowCount) },
        scalar: Boolean(window) && window.start.col === window.end.col && window.start.row === window.end.row
      }
    };
  }
  if (address.type === "ref") {
    const at = shifted(address.ref);
    if (window && (at.col > window.end.col || at.row > window.end.row)) {
      return { error: withDetail(ERR.REF, `${label} reaches outside the section.`) };
    }
    return { cells: { tableId, start: at, end: at, scalar: true } };
  }
  if (address.type === "range") {
    const start = shifted({ col: Math.min(address.start.col, address.end.col), row: Math.min(address.start.row, address.end.row) });
    const end = shifted({ col: Math.max(address.start.col, address.end.col), row: Math.max(address.start.row, address.end.row) });
    if (window && (end.col > window.end.col || end.row > window.end.row)) {
      return { error: withDetail(ERR.REF, `${label} reaches outside the section.`) };
    }
    return { cells: { tableId, start, end, scalar: false } };
  }
  return { error: ERR.VALUE };
}

/**
 * Locate a section or table by its stable id (backs `REF("id")`).
 * @param {{ pages: Record<string, any>, pageOrder: Record<string, string[]>, detached?: Record<string, any> }} data
 * @param {string} id
 * @returns {Located | undefined} Undefined when nothing has that id.
 */
export function locateById(data, id) {
  const found = findSection(data, id);
  if (found) {
    return locateTarget(data, { kind: "section", pageId: found.containerId, sectionId: id }, null, id);
  }
  for (const [containerId, container] of allContainers(data)) {
    if (container?.content?.tables?.[id]) {
      return locateTarget(data, { kind: "table", pageId: containerId, tableId: id }, null, id);
    }
  }
  return undefined;
}
