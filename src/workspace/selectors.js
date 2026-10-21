/**
 * Read-only views of the workspace for rendering.
 *
 * `Workspace.getPage` / `getPages` deep-copy a page and its whole content, which is the right
 * thing for a caller that keeps or edits the result but wasteful for chrome that only needs a
 * title or a type. Selectors read the live data and return small plain values (or, for
 * `pageContent`, the live content, which must not be mutated).
 */

/** @typedef {import("./store.js").Workspace} Workspace */
/** @typedef {import("./schema.js").PageType} PageType */

/**
 * @typedef {object} PageInfo
 * @property {string} id
 * @property {string} title Raw title (may be empty).
 * @property {PageType} type
 */

/**
 * @param {Workspace} workspace
 * @param {string | null | undefined} pageId
 * @returns {boolean}
 */
export function pageExists(workspace, pageId) {
  return typeof pageId === "string" && Boolean(workspace.data.pages[pageId]);
}

/**
 * @param {Workspace} workspace
 * @param {string | null | undefined} pageId
 * @returns {string | undefined} The raw title, or undefined when there is no such page.
 */
export function pageTitle(workspace, pageId) {
  return typeof pageId === "string" ? workspace.data.pages[pageId]?.title : undefined;
}

/**
 * @param {Workspace} workspace
 * @param {string | null | undefined} pageId
 * @returns {PageType | undefined}
 */
export function pageType(workspace, pageId) {
  return typeof pageId === "string" ? workspace.data.pages[pageId]?.type : undefined;
}

/**
 * Id, title and type of a page, without its content.
 * @param {Workspace} workspace
 * @param {string | null | undefined} pageId
 * @returns {PageInfo | undefined}
 */
export function pageInfo(workspace, pageId) {
  const page = typeof pageId === "string" ? workspace.data.pages[pageId] : undefined;
  return page ? { id: page.id, title: page.title, type: page.type } : undefined;
}

/**
 * A page's live content object. Read-only: never mutate it, and do not keep it across
 * commands (undo replaces the whole state). Undefined for a page that has no content yet.
 * @param {Workspace} workspace
 * @param {string | null | undefined} pageId
 * @returns {any}
 */
export function pageContent(workspace, pageId) {
  return typeof pageId === "string" ? workspace.contentOf(pageId) : undefined;
}

/**
 * Every page as id/title/type, in no particular order.
 * @param {Workspace} workspace
 * @returns {PageInfo[]}
 */
export function pageList(workspace) {
  return Object.values(workspace.data.pages).map((page) => ({
    id: page.id,
    title: page.title,
    type: page.type
  }));
}

/**
 * The pages from the top of the tree down to `pageId`, inclusive. Empty for an unknown page.
 * @param {Workspace} workspace
 * @param {string | null | undefined} pageId
 * @returns {PageInfo[]}
 */
export function breadcrumb(workspace, pageId) {
  if (!pageExists(workspace, pageId)) return [];
  /** @type {PageInfo[]} */
  const trail = [];
  const seen = new Set();
  /** @type {string | null} */
  let cursor = /** @type {string} */ (pageId);
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const info = pageInfo(workspace, cursor);
    if (!info) break;
    trail.unshift(info);
    cursor = workspace.getParent(cursor);
  }
  return trail;
}

/**
 * @typedef {PageInfo & { children: PageTreeNode[] }} PageTreeNode
 */

/**
 * The page hierarchy as nested nodes in sidebar order.
 * @param {Workspace} workspace
 * @returns {PageTreeNode[]}
 */
export function pageTree(workspace) {
  const seen = new Set();
  /** @param {string | null} parentId @returns {PageTreeNode[]} */
  const build = (parentId) => {
    /** @type {PageTreeNode[]} */
    const nodes = [];
    for (const id of workspace.getChildren(parentId)) {
      const info = pageInfo(workspace, id);
      if (!info || seen.has(id)) continue;
      seen.add(id);
      nodes.push({ ...info, children: build(id) });
    }
    return nodes;
  };
  return build(null);
}
