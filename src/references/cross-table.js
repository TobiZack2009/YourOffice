/**
 * Rewriting formulas elsewhere when a table is edited.
 *
 * Row/column inserts and deletes, cell shifts and cell moves change addresses in
 * one table, and any formula that points into it must follow: the table's own
 * formulas, formulas in other tables, and (later) reference expressions. Which
 * references "point into" the edited table is decided per formula, because an
 * unqualified `A1` means the formula's own table while `Plan!Costs!A1` is resolved
 * from the formula's page.
 */

import { collectFormulaSites } from "./rewrite.js";
import { resolveTarget } from "./scope.js";

/**
 * @typedef {import("./rewrite.js").FormulaSite} FormulaSite
 * @typedef {(segments: string[]) => boolean} TargetTest
 */

/**
 * Apply `rewrite` to every formula in the workspace, telling it which of the
 * formula's references point into `tableId`.
 *
 * @param {import("./scope.js").ScopeData} data
 * @param {string} tableId The edited table.
 * @param {(text: string, target: TargetTest, site: FormulaSite) => string} rewrite
 * @param {{
 *   local?: boolean,
 *   skip?: (site: FormulaSite) => boolean,
 *   touch?: (pageId: string) => void
 * }} [options] `local`: also treat unqualified references in the edited table's own
 *   formulas as pointing into it (default: only qualified references do, because the
 *   table's own cell store handles its unqualified ones). `skip`: leave a site alone.
 * @returns {number} Number of formulas changed.
 */
export function rewriteTableReferences(data, tableId, rewrite, options = {}) {
  /** @type {Map<string, boolean>} */
  const memo = new Map();
  const pointsInto = (/** @type {string} */ pageId, /** @type {string[]} */ segments) => {
    const key = `${pageId}\u0000${segments.join("\u0000")}`;
    let answer = memo.get(key);
    if (answer === undefined) {
      const target = resolveTarget(data, pageId, segments).target;
      answer = target?.kind === "table" && target.tableId === tableId;
      memo.set(key, answer);
    }
    return answer;
  };

  let changed = 0;
  for (const site of collectFormulaSites(data)) {
    if (options.skip?.(site)) continue;
    const text = site.read();
    if (typeof text !== "string") continue;
    /** @type {TargetTest} */
    const target = (segments) =>
      segments.length === 0
        ? Boolean(options.local) && site.tableId === tableId
        : pointsInto(site.pageId, segments);
    const next = rewrite(text, target, site);
    if (next === text) continue;
    site.write(next);
    changed += 1;
    options.touch?.(site.pageId);
  }
  return changed;
}
