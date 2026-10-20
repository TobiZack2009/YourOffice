/**
 * What a transaction changed, in terms editors can act on.
 *
 * A commit, undo or redo event carries `pages` (ids of the pages or detached entries that
 * changed), `entities` (per page, the ids inside it that changed) and `registry` (the page
 * tree, titles, favourites or workspace title changed). Command handlers record entities with
 * `touchPage(tx, page, ...ids)`; a handler that cannot say what changed records none, which
 * means "treat the whole page as changed".
 *
 * Entity ids by page type:
 *   - document: block ids (a changed block includes everything nested in it);
 *   - sheet: table ids (stored content only; values computed from formulas are not listed);
 *   - presentation: the slide id, plus the ids of the objects that changed on it. A slide id
 *     with no object of that slide means the slide as a whole changed.
 */

/** Entity id meaning "this page changed in ways not described by ids". */
export const WHOLE_PAGE = "*";

/**
 * @typedef {object} Change
 * @property {"commit" | "undo" | "redo"} kind
 * @property {string} transactionId
 * @property {string} label
 * @property {string[]} commands Command types applied, in order.
 * @property {string[]} pages Ids of the pages (or detached entries) touched.
 * @property {Map<string, Set<string>>} entities Touched entity ids per page id.
 * @property {boolean} registry Whether the page registry (tree, titles, favourites, workspace title) changed.
 * @property {string | undefined} origin Who dispatched it (an editor's own id), so it can skip its own echo.
 */

/**
 * Whether a change touched a page.
 * @param {{ pages?: string[] } | undefined} change
 * @param {string} pageId
 * @returns {boolean}
 */
export function touchesPage(change, pageId) {
  return Array.isArray(change?.pages) && change.pages.includes(pageId);
}

/**
 * The entity ids changed on a page, or `null` when the whole page must be treated as changed
 * (the change did not record entities, or recorded the whole page).
 * @param {{ entities?: Map<string, Set<string>> } | undefined} change
 * @param {string} pageId
 * @returns {Set<string> | null}
 */
export function entitiesOf(change, pageId) {
  const ids = change?.entities?.get(pageId);
  if (!ids || ids.size === 0 || ids.has(WHOLE_PAGE)) return null;
  return ids;
}

/**
 * Merge entity maps (used when history entries are combined).
 * @param {Map<string, Set<string>>} into
 * @param {Map<string, Set<string>>} from
 */
export function mergeEntities(into, from) {
  for (const [pageId, ids] of from) {
    const set = into.get(pageId) ?? new Set();
    for (const id of ids) set.add(id);
    into.set(pageId, set);
  }
}

/**
 * Deep copy of an entity map.
 * @param {Map<string, Set<string>>} entities
 * @returns {Map<string, Set<string>>}
 */
export function cloneEntities(entities) {
  return new Map([...entities].map(([pageId, ids]) => [pageId, new Set(ids)]));
}
