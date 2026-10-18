/**
 * Scope and name resolution (pure).
 *
 * Page nesting is scope nesting. A page's *members* are its tables, its named
 * sections and its child pages; the workspace root's members are the top-level
 * pages. A bare name resolves from the page that holds the formula outward
 * (the page, its parent, ... the root) and the first scope with a match wins.
 * A path `A!B!C` resolves its first segment that way and each later segment
 * inside the page named before it.
 *
 * Everything here reads the plain workspace data (`{ pages, pageOrder }`), so it
 * works on `store._data` and on hand-built fixtures alike. Nothing is cached.
 *
 * Section registries (`content.sections`, added in Phase 6 layer 4) are read when
 * present; a section without a name is implicit and not addressable by name.
 */

import { ERR, withDetail } from "../sheet/errors.js";
import { formatName, nameKey } from "../sheet/names.js";
import { containerOf, scopePageOf } from "./containers.js";

/**
 * @typedef {object} ScopeData
 * @property {Record<string, any>} pages
 * @property {Record<string, string[]>} pageOrder
 * @property {Record<string, any>} [detached] Detached content, readable like pages.
 */

/**
 * What a name points at. Identity is by id, never by name.
 * @typedef {object} Target
 * @property {"page" | "table" | "section"} kind
 * @property {string} pageId Page that owns the member (the page itself for `page`).
 * @property {string} [tableId]
 * @property {string} [sectionId]
 */

/**
 * A named member of a scope.
 * @typedef {Target & { name: string }} Member
 */

/**
 * @param {Target} target
 * @returns {string}
 */
export function targetKey(target) {
  if (target.kind === "table") return `table:${target.tableId}`;
  if (target.kind === "section") return `section:${target.sectionId}`;
  return `page:${target.pageId}`;
}

/**
 * @param {Target | null | undefined} a
 * @param {Target | null | undefined} b
 * @returns {boolean}
 */
export function sameTarget(a, b) {
  return !!a && !!b && targetKey(a) === targetKey(b);
}

/**
 * Named members of a scope, tables and sections first (in page order), then child pages.
 * @param {ScopeData} data
 * @param {string | null} scopeId Page id, or null for the workspace root.
 * @returns {Member[]}
 */
export function membersOf(data, scopeId) {
  /** @type {Member[]} */
  const members = [];
  /** @param {string} id */
  const addContents = (id) => {
    const page = containerOf(data, id);
    const content = page?.content;
    if (!page || !content || typeof content !== "object") return;
    if (page.type === "sheet" && content.tables && typeof content.tables === "object") {
      const order = Array.isArray(content.tableOrder) ? content.tableOrder : Object.keys(content.tables);
      for (const tableId of order) {
        const table = content.tables[tableId];
        if (table && typeof table.name === "string" && table.name !== "") {
          members.push({ kind: "table", name: table.name, pageId: id, tableId });
        }
      }
    }
    if (content.sections && typeof content.sections === "object") {
      for (const section of Object.values(content.sections)) {
        const s = /** @type {any} */ (section);
        if (s && typeof s.name === "string" && s.name !== "") {
          members.push({ kind: "section", name: s.name, pageId: id, sectionId: s.id });
        }
      }
    }
  };
  if (scopeId !== null) addContents(scopeId);
  const children = scopeId === null ? data.pageOrder?.root : data.pageOrder?.[scopeId];
  for (const id of children ?? []) {
    const page = data.pages[id];
    if (page && typeof page.title === "string" && page.title !== "") {
      members.push({ kind: "page", name: page.title, pageId: id });
    }
  }
  // Detached content stays addressable where it used to live, after everything live.
  if (data.detached && (scopeId === null || data.pages[scopeId])) {
    for (const id of Object.keys(data.detached)) {
      if (scopePageOf(data, id) === scopeId) addContents(id);
    }
  }
  return members;
}

/**
 * Parent page id, or null for a top-level page (or an unknown page).
 * @param {ScopeData} data
 * @param {string} pageId
 * @returns {string | null}
 */
export function parentOf(data, pageId) {
  for (const [key, list] of Object.entries(data.pageOrder ?? {})) {
    if (key !== "root" && Array.isArray(list) && list.includes(pageId)) return key;
  }
  return null;
}

/**
 * Scopes visible from a page, innermost first, ending with the root (null).
 * @param {ScopeData} data
 * @param {string} pageId
 * @returns {(string | null)[]}
 */
export function scopeChain(data, pageId) {
  /** @type {(string | null)[]} */
  const chain = [];
  const seen = new Set();
  /** @type {string | null} */
  let current = data.pages[pageId] ? pageId : scopePageOf(data, pageId);
  while (current !== null && !seen.has(current) && data.pages[current]) {
    seen.add(current);
    chain.push(current);
    current = parentOf(data, current);
  }
  chain.push(null);
  return chain;
}

/**
 * @param {ScopeData} data
 * @param {string | null} scopeId
 * @param {string} key
 * @param {(member: Member) => boolean} accept
 * @returns {Member[]}
 */
function matchesIn(data, scopeId, key, accept) {
  return membersOf(data, scopeId).filter((member) => nameKey(member.name) === key && accept(member));
}

/**
 * Levenshtein distance, bounded for short names.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * The visible name closest to `name`, for "did you mean" hints.
 * @param {ScopeData} data
 * @param {string | null} fromPageId Page the name is written on (null with `inside`).
 * @param {string} name
 * @param {{ inside?: string }} [options] Look only inside this page's members.
 * @returns {string | null}
 */
export function closestName(data, fromPageId, name, options = {}) {
  const wanted = nameKey(name);
  if (wanted === "") return null;
  /** @type {Member[]} */
  const candidates = options.inside
    ? membersOf(data, options.inside)
    : (fromPageId === null ? [null] : scopeChain(data, fromPageId)).flatMap((scope) => membersOf(data, scope));
  const limit = Math.max(1, Math.floor(wanted.length / 3));
  let best = null;
  let bestDistance = Infinity;
  for (const member of candidates) {
    const key = nameKey(member.name);
    let d = distance(wanted, key);
    if (d > limit && (key.startsWith(wanted) || wanted.startsWith(key)) && Math.min(key.length, wanted.length) >= 3) {
      d = limit;
    }
    if (d <= limit && d < bestDistance) {
      best = member.name;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Display title for a page, for messages.
 * @param {ScopeData} data
 * @param {string} pageId
 * @returns {string}
 */
function titleOf(data, pageId) {
  return containerOf(data, pageId)?.title || data.detached?.[pageId]?.origin?.title || "Untitled";
}

/**
 * @typedef {object} Resolution
 * @property {Target} [target]
 * @property {import("../sheet/errors.js").FormulaError} [error]
 * @property {boolean} [ambiguous] A page segment matched several pages.
 */

/**
 * Resolve a bare name or path to what it names.
 * @param {ScopeData} data
 * @param {string} fromPageId Page the formula lives on.
 * @param {string[]} segments
 * @returns {Resolution}
 */
export function resolveTarget(data, fromPageId, segments) {
  if (segments.length === 0) {
    return { error: withDetail(ERR.NAME, "There is no name to look up.") };
  }
  /** @type {string | null} */
  let container = null;
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const key = nameKey(segments[i]);
    /** @type {(member: Member) => boolean} */
    const accept = last ? () => true : (member) => member.kind === "page";

    /** @type {Member[]} */
    let matches = [];
    if (i === 0) {
      for (const scope of scopeChain(data, fromPageId)) {
        matches = matchesIn(data, scope, key, accept);
        if (matches.length > 0) break;
      }
    } else {
      matches = matchesIn(data, container, key, accept);
    }

    if (matches.length === 0) {
      const hint = closestName(data, i === 0 ? fromPageId : null, segments[i], i === 0 ? {} : { inside: /** @type {string} */ (container) });
      const where = i === 0 ? "" : ` inside "${titleOf(data, /** @type {string} */ (container))}"`;
      const detail =
        `Nothing${where} is named "${segments[i]}".` + (hint ? ` Did you mean "${hint}"?` : "");
      return { error: withDetail(ERR.NAME, detail) };
    }

    const concrete = matches.filter((member) => member.kind !== "page");
    if (last && concrete.length > 0) {
      return { target: stripName(concrete[0]) };
    }
    const pages = matches.filter((member) => member.kind === "page");
    if (pages.length > 1) {
      return {
        ambiguous: true,
        error: withDetail(
          ERR.NAME,
          `Several pages are called "${segments[i]}". Rename one of them, or write the path from a page that tells them apart.`
        )
      };
    }
    if (last) return { target: stripName(pages[0]) };
    container = pages[0].pageId;
  }
  return { error: withDetail(ERR.NAME, "The name could not be resolved.") };
}

/**
 * @param {Member} member
 * @returns {Target}
 */
function stripName(member) {
  /** @type {Target} */
  const target = { kind: member.kind, pageId: member.pageId };
  if (member.tableId !== undefined) target.tableId = member.tableId;
  if (member.sectionId !== undefined) target.sectionId = member.sectionId;
  return target;
}

/**
 * Current name of a target, or null when it no longer exists or has no name.
 * @param {ScopeData} data
 * @param {Target} target
 * @returns {string | null}
 */
export function nameOfTarget(data, target) {
  const page = containerOf(data, target.pageId);
  if (!page) return null;
  if (target.kind === "page") return data.pages[target.pageId] ? page.title || null : null;
  if (target.kind === "table") {
    return page.content?.tables?.[/** @type {string} */ (target.tableId)]?.name || null;
  }
  return page.content?.sections?.[/** @type {string} */ (target.sectionId)]?.name || null;
}

/**
 * Ids of a page and its ancestors, root-most first.
 * @param {ScopeData} data
 * @param {string} pageId
 * @returns {string[]}
 */
function pathOfPage(data, pageId) {
  const live = data.pages[pageId] ? pageId : scopePageOf(data, pageId);
  if (live === null) return [];
  return scopeChain(data, live)
    .filter((id) => id !== null)
    .map((id) => /** @type {string} */ (id))
    .reverse();
}

/**
 * The shortest segment list that resolves to `target` when written on `fromPageId`:
 * the bare name when that already works, else the fewest page titles needed in
 * front of it. Null when the target has no usable name or no spelling resolves
 * to it (duplicate page titles all the way up).
 * @param {ScopeData} data
 * @param {string} fromPageId
 * @param {Target} target
 * @returns {string[] | null}
 */
export function qualifyToKeepTarget(data, fromPageId, target) {
  if (!containerOf(data, target.pageId)) return null;
  const memberName = nameOfTarget(data, target);
  if (memberName === null) return null;
  // Path of pages down to the owner, then the member itself.
  const owners = pathOfPage(data, target.pageId).map((id) => data.pages[id].title || "");
  const path = target.kind === "page" ? owners : [...owners, memberName];
  if (path.some((segment) => segment === "")) return null;
  for (let take = 1; take <= path.length; take++) {
    const tail = path.slice(path.length - take);
    if (sameTarget(resolveTarget(data, fromPageId, tail).target, target)) return tail;
  }
  return null;
}

/**
 * Source text for a segment list (`Plan!'Q3 Budget'`).
 * @param {string[]} segments
 * @returns {string}
 */
export function formatPath(segments) {
  return segments.map(formatName).join("!");
}

/**
 * Whether a table or section name is already taken on a page.
 * @param {ScopeData} data
 * @param {string} pageId
 * @param {string} name
 * @param {string} [exceptId] Table or section id to ignore (the thing being renamed).
 * @returns {boolean}
 */
export function nameTaken(data, pageId, name, exceptId) {
  const key = nameKey(name);
  return membersOf(data, pageId).some(
    (member) =>
      member.kind !== "page" &&
      nameKey(member.name) === key &&
      (member.tableId ?? member.sectionId) !== exceptId
  );
}

/**
 * A table/section name unique on its page: `Costs`, then `Costs 2`, `Costs 3`...
 * @param {ScopeData} data
 * @param {string} pageId
 * @param {string} desired
 * @param {string} [exceptId]
 * @returns {string}
 */
export function uniqueName(data, pageId, desired, exceptId) {
  if (!nameTaken(data, pageId, desired, exceptId)) return desired;
  const match = /^(.*\S) (\d+)$/.exec(desired);
  const base = match ? match[1] : desired;
  let n = match ? Number(match[2]) + 1 : 2;
  while (nameTaken(data, pageId, `${base} ${n}`, exceptId)) n += 1;
  return `${base} ${n}`;
}

/**
 * Names a parsed formula refers to, in source order.
 * @param {any} ast
 * @returns {{ segments: string[], address: any | null }[]}
 */
export function collectNames(ast) {
  /** @type {{ segments: string[], address: any | null }[]} */
  const found = [];
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === "name") {
      found.push({ segments: [node.name], address: null });
      return;
    }
    if (node.type === "path") {
      found.push({ segments: node.segments, address: node.address ?? null });
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(ast);
  return found;
}
