/**
 * Containers: anything that holds page-shaped content.
 *
 * A live page is a container. So is a *detached* entry: content that lost its
 * page (or its slot in one) while something still refers to it. Both have a
 * `type`, a `content` of the matching shape and a section registry, so every
 * reader written for pages (renderers, resolvers, commands) works on detached
 * content without knowing the difference. Only the places that care about the
 * page hierarchy have to ask whether a container is live.
 */

/**
 * @typedef {object} ContainerData
 * @property {Record<string, any>} pages
 * @property {Record<string, string[]>} [pageOrder]
 * @property {Record<string, any>} [detached]
 */

/**
 * @param {ContainerData} data
 * @param {string | null | undefined} id Page id or detached id.
 * @returns {any | undefined}
 */
export function containerOf(data, id) {
  if (typeof id !== "string") return undefined;
  return data.pages?.[id] ?? data.detached?.[id];
}

/**
 * @param {ContainerData} data
 * @param {string} id
 * @returns {boolean} Whether `id` names a detached entry rather than a live page.
 */
export function isDetached(data, id) {
  return !data.pages?.[id] && Boolean(data.detached?.[id]);
}

/**
 * Every container, live pages first, then detached entries.
 * @param {ContainerData} data
 * @returns {Array<[string, any]>}
 */
export function allContainers(data) {
  return [...Object.entries(data.pages ?? {}), ...Object.entries(data.detached ?? {})];
}

/**
 * The live page whose names a container reads: the page itself, or for detached
 * content the page it came from (when that page still exists).
 * @param {ContainerData} data
 * @param {string} id
 * @returns {string | null}
 */
export function scopePageOf(data, id) {
  if (data.pages?.[id]) return id;
  const origin = data.detached?.[id]?.origin?.pageId;
  return typeof origin === "string" && data.pages?.[origin] ? origin : null;
}
