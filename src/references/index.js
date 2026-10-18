/**
 * The reverse index of references (pure).
 *
 * "Who points at this?" is answered by scanning, never by stored back-pointers,
 * so there is nothing to keep in sync and nothing to corrupt. A *site* is one
 * thing that reads another: an embed, a reference expression or a cell formula.
 * Targets are graph nodes: `sec:<sectionId>` and `tbl:<tableId>`.
 *
 * The same scan feeds cycle detection (an embed that would end up showing
 * itself) and `validateReference`, which commands and the UI share so a bad
 * reference is refused the same way everywhere.
 */

import { allContainers, containerOf } from "./containers.js";
import { walkReferenceHosts } from "./hosts.js";
import { findSection, sectionsCovering } from "./sections.js";
import { collectTargets, evaluateExpression, parseExpression, targetsOfAst } from "./expression.js";
import { explain, isFormulaError } from "../sheet/errors.js";

/**
 * @typedef {object} ReferenceSite
 * @property {"embed" | "expression" | "formula"} source
 * @property {string} containerId Page or detached id that holds the site.
 * @property {string} [instanceId] Embed / expression instance id.
 * @property {string} [tableId] Cell formulas: the table.
 * @property {{ col: number, row: number }} [position] Cell formulas: 0-based position.
 * @property {import("./hosts.js").ReferenceHost["where"]} [where] Embeds and expressions: where it sits.
 * @property {{ node: string, containerId: string }[]} targets
 */

/**
 * Every reading site in the workspace with what it reads.
 * @param {import("./containers.js").ContainerData & { pageOrder: Record<string, string[]> }} data
 * @returns {ReferenceSite[]}
 */
export function collectReferenceSites(data) {
  /** @type {ReferenceSite[]} */
  const sites = [];
  walkReferenceHosts(data, (host) => {
    /** @type {ReferenceSite["targets"]} */
    let targets;
    if (host.kind === "embed") {
      const found = host.sectionId ? findSection(data, host.sectionId) : null;
      targets = host.sectionId ? [{ node: `sec:${host.sectionId}`, containerId: found?.containerId ?? "" }] : [];
    } else {
      targets = typeof host.expression === "string" ? collectTargets(data, host.containerId, host.expression) : [];
    }
    sites.push({
      source: host.kind,
      containerId: host.containerId,
      instanceId: host.instanceId,
      where: host.where,
      targets
    });
  });
  for (const [containerId, container] of allContainers(data)) {
    if (container?.type !== "sheet") continue;
    for (const table of Object.values(/** @type {Record<string, any>} */ (container.content?.tables ?? {}))) {
      for (const [key, cell] of Object.entries(/** @type {Record<string, any>} */ (table.cells ?? {}))) {
        if (typeof cell?.formula !== "string") continue;
        const parsed = parseExpression(cell.formula);
        if (!("ast" in parsed)) continue;
        const targets = targetsOfAst(data, containerId, parsed.ast);
        if (targets.length === 0) continue;
        const [col, row] = key.split(",").map(Number);
        sites.push({ source: "formula", containerId, tableId: table.id, position: { col, row }, targets });
      }
    }
  }
  return sites;
}

/**
 * Nodes that stand for a section.
 * @param {string} sectionId
 * @returns {string[]}
 */
export function sectionNodes(sectionId) {
  return [`sec:${sectionId}`];
}

/**
 * Nodes that stand for a table: itself and every section over it.
 * @param {any} container Page or detached entry holding the table.
 * @param {string} tableId
 * @returns {string[]}
 */
export function tableNodes(container, tableId) {
  const sections = Object.values(/** @type {Record<string, any>} */ (container?.content?.sections ?? {}));
  return [`tbl:${tableId}`, ...sections.filter((s) => s.locator?.tableId === tableId).map((s) => `sec:${s.id}`)];
}

/**
 * Sites that read any of the given nodes.
 * @param {import("./containers.js").ContainerData & { pageOrder: Record<string, string[]> }} data
 * @param {string[]} nodes
 * @param {(site: ReferenceSite) => boolean} [ignore] Sites that do not count (content about to be deleted).
 * @returns {ReferenceSite[]}
 */
export function referencesTo(data, nodes, ignore) {
  const wanted = new Set(nodes);
  return collectReferenceSites(data).filter(
    (site) => site.targets.some((target) => wanted.has(target.node)) && !(ignore && ignore(site))
  );
}

/**
 * @param {import("./containers.js").ContainerData & { pageOrder: Record<string, string[]> }} data
 * @param {string[]} nodes
 * @param {(site: ReferenceSite) => boolean} [ignore]
 * @returns {number}
 */
export function countReferences(data, nodes, ignore) {
  return referencesTo(data, nodes, ignore).length;
}

// -- cycles -------------------------------------------------------------------

/**
 * Find a loop in "contains / reads" relations: a section whose content reaches
 * itself through embeds and expressions. Table-to-table reads are not edges here:
 * those are checked per cell by the recalculation engine, where `T1!A1 -> T2!A1`
 * with `T2!B1 -> T1!B1` is perfectly fine.
 * @param {import("./containers.js").ContainerData & { pageOrder: Record<string, string[]> }} data
 * @returns {string[] | null} The nodes of one loop, in order, or null.
 */
export function findReferenceCycle(data) {
  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  /** @type {Set<string>} */
  const tableish = new Set();
  /**
   * @param {string} from
   * @param {string} to
   */
  const add = (from, to) => {
    let set = edges.get(from);
    if (!set) edges.set(from, (set = new Set()));
    set.add(to);
  };

  for (const [, container] of allContainers(data)) {
    for (const section of Object.values(/** @type {Record<string, any>} */ (container?.content?.sections ?? {}))) {
      if (container.type === "sheet") {
        tableish.add(`sec:${section.id}`);
        add(`sec:${section.id}`, `tbl:${section.locator.tableId}`);
      }
    }
    if (container?.type === "sheet") {
      for (const id of Object.keys(container.content?.tables ?? {})) tableish.add(`tbl:${id}`);
    }
  }

  for (const site of collectReferenceSites(data)) {
    const container = containerOf(data, site.containerId);
    /** @type {string[]} */
    let from = [];
    if (site.source === "formula") {
      from = [`tbl:${site.tableId}`];
    } else if (site.where) {
      from = sectionsCovering(container, site.where).map((section) => `sec:${section.id}`);
    }
    for (const source of from) {
      for (const target of site.targets) {
        if (tableish.has(source) && tableish.has(target.node)) continue;
        add(source, target.node);
      }
    }
  }

  /** @type {Map<string, number>} 1 = on the current path, 2 = finished */
  const state = new Map();
  /** @type {string[]} */
  const path = [];
  /**
   * @param {string} node
   * @returns {string[] | null}
   */
  const visit = (node) => {
    state.set(node, 1);
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === 1) return [...path.slice(path.indexOf(next)), next];
      if (!state.has(next)) {
        const loop = visit(next);
        if (loop) return loop;
      }
    }
    path.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of edges.keys()) {
    if (!state.has(node)) {
      const loop = visit(node);
      if (loop) return loop;
    }
  }
  return null;
}

// -- validation ---------------------------------------------------------------

/**
 * @typedef {object} Validation
 * @property {boolean} ok
 * @property {string} [message] Plain-language reason, shown next to the field and in `CommandError`.
 * @property {string} [code] Formula error code when an expression evaluated to an error.
 */

/**
 * Decide whether a reference instance that already sits in `data` may stay.
 * Commands insert/patch first and call this after, so the answer reflects the
 * real position (a throw rolls the transaction back).
 * @param {import("./containers.js").ContainerData & { pageOrder: Record<string, string[]> }} data
 * @param {import("./hosts.js").ReferenceHost} host
 * @returns {Validation}
 */
export function validateReference(data, host) {
  const container = containerOf(data, host.containerId);
  if (!container) return { ok: false, message: "That page does not exist." };
  if (container.type === "sheet") {
    return { ok: false, message: "References cannot be placed inside a sheet yet; use a formula there." };
  }

  if (host.kind === "embed") {
    if (!host.sectionId) return { ok: false, message: "Choose something to show." };
    if (!findSection(data, host.sectionId)) {
      return { ok: false, message: "That section no longer exists." };
    }
  } else {
    if (typeof host.expression !== "string" || host.expression.trim() === "") {
      return { ok: false, message: "Write an expression, for example Costs!B2 or IF(Total > 10, Summary, \"\")." };
    }
    const result = evaluateExpression(data, host.containerId, host.expression);
    if (isFormulaError(result.value)) {
      const info = explain(result.value);
      return { ok: false, message: info.text, code: result.value.code };
    }
  }

  const loop = findReferenceCycle(data);
  if (loop) {
    return { ok: false, message: "That would make the content show itself, directly or through other references." };
  }
  return { ok: true };
}
