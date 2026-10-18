/**
 * Keeping formulas pointed at the same thing when names or places change.
 *
 * Formula text is authoritative, so when a table or section is renamed, a page is
 * renamed or moved, or a new name starts shadowing an old one, the text of every
 * formula that names something is rewritten token by token (spacing, strings and
 * the address part are never touched). The recipe is always the same:
 *
 *   const snapshot = snapshotReferences(data);   // who points at what, right now
 *   ... mutate names / pages ...
 *   retargetReferences(data, snapshot, touch);   // respell whatever no longer resolves the same
 *
 * A reference is left alone while its text still resolves to its old target. When
 * it does not (renamed away, or now caught by a closer name), it is respelled as
 * the shortest path that reaches the same target, qualified with page titles when
 * a bare name would no longer do.
 *
 * "Sites" are the places formula text lives: cell formulas today; reference
 * expressions register themselves with `siteSources`.
 */

import { rewriteFormula } from "../sheet/refscan.js";
import { formatPath, qualifyToKeepTarget, resolveTarget, targetKey } from "./scope.js";
import { allContainers } from "./containers.js";
import { walkReferenceHosts } from "./hosts.js";

/**
 * @typedef {object} FormulaSite
 * @property {string} pageId Page whose scope the formula is read in.
 * @property {string} [tableId] Table holding the formula (cell formulas only).
 * @property {{ col: number, row: number }} [position] 0-based cell position (cell formulas only).
 * @property {() => string | undefined} read Current formula text.
 * @property {(text: string) => void} write
 */

/**
 * Producers of formula sites. Each takes the workspace data and returns its sites.
 * @type {Array<(data: import("./scope.js").ScopeData) => FormulaSite[]>}
 */
export const siteSources = [cellFormulaSites, expressionSites];

/**
 * Every formula in sheet cells.
 * @param {import("./scope.js").ScopeData} data
 * @returns {FormulaSite[]}
 */
function cellFormulaSites(data) {
  /** @type {FormulaSite[]} */
  const sites = [];
  for (const [pageId, page] of allContainers(data)) {
    if (page?.type !== "sheet" || !page.content?.tables) continue;
    for (const table of Object.values(page.content.tables)) {
      for (const [key, cell] of Object.entries(/** @type {Record<string, any>} */ (table.cells ?? {}))) {
        if (typeof cell?.formula !== "string") continue;
        const [col, row] = key.split(",").map(Number);
        sites.push({
          pageId,
          tableId: table.id,
          position: { col, row },
          read: () => cell.formula,
          write: (text) => {
            cell.formula = text;
          }
        });
      }
    }
  }
  return sites;
}

/**
 * Every reference expression (`kind: "expression"`) in documents and presentations.
 * @param {import("./scope.js").ScopeData} data
 * @returns {FormulaSite[]}
 */
function expressionSites(data) {
  /** @type {FormulaSite[]} */
  const sites = [];
  walkReferenceHosts(data, (host) => {
    if (host.kind !== "expression" || typeof host.expression !== "string") return;
    sites.push({
      pageId: host.containerId,
      read: () => host.record.expression,
      write: (text) => {
        host.record.expression = text;
      }
    });
  });
  return sites;
}

/**
 * All formula sites in the workspace.
 * @param {import("./scope.js").ScopeData} data
 * @returns {FormulaSite[]}
 */
export function collectFormulaSites(data) {
  return siteSources.flatMap((source) => source(data));
}

/**
 * @typedef {object} ReferenceSnapshot
 * @property {{ site: FormulaSite, targets: (import("./scope.js").Target | null)[] }[]} entries
 */

/**
 * Record what every named reference in every formula points at.
 * @param {import("./scope.js").ScopeData} data
 * @returns {ReferenceSnapshot}
 */
export function snapshotReferences(data) {
  /** @type {ReferenceSnapshot["entries"]} */
  const entries = [];
  for (const site of collectFormulaSites(data)) {
    const text = site.read();
    if (typeof text !== "string") continue;
    /** @type {(import("./scope.js").Target | null)[] | null} */
    let targets = null;
    rewriteFormula(text, ({ units }) => {
      targets = units.map((unit) =>
        unit.segments.length === 0 ? null : (resolveTarget(data, site.pageId, unit.segments).target ?? null)
      );
      return [];
    });
    if (targets && /** @type {any[]} */ (targets).some(Boolean)) entries.push({ site, targets });
  }
  return { entries };
}

/**
 * Respell every reference that no longer resolves to its recorded target.
 * @param {import("./scope.js").ScopeData} data
 * @param {ReferenceSnapshot} snapshot
 * @param {(pageId: string) => void} [touch] Called with each page whose formulas changed.
 * @returns {number} Number of formulas rewritten.
 */
export function retargetReferences(data, snapshot, touch) {
  let changed = 0;
  for (const { site, targets } of snapshot.entries) {
    const text = site.read();
    if (typeof text !== "string") continue;
    const next = rewriteFormula(text, ({ units }) => {
      if (units.length !== targets.length) return [];
      /** @type {import("../sheet/refscan.js").Edit[]} */
      const edits = [];
      units.forEach((unit, index) => {
        const before = targets[index];
        if (!before || unit.segments.length === 0) return;
        const now = resolveTarget(data, site.pageId, unit.segments).target;
        if (now && targetKey(now) === targetKey(before)) return;
        const spelled = qualifyToKeepTarget(data, site.pageId, before);
        if (!spelled) return;
        edits.push({
          from: unit.segmentTokens[0],
          to: unit.segmentTokens[unit.segmentTokens.length - 1],
          text: formatPath(spelled)
        });
      });
      return edits;
    });
    // Expressions may be stored without the leading "=".
    const output = next !== text && !text.trimStart().startsWith("=") ? next.slice(1) : next;
    if (output !== text) {
      site.write(output);
      changed += 1;
      touch?.(site.pageId);
    }
  }
  return changed;
}
