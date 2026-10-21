import { findContainer } from "../document/model.js";
import { containerOf } from "../references/containers.js";
import { sectionBlockIds, sectionRunIds, findSection } from "../references/sections.js";

/**
 * A store-shaped view of one section of a container, for an editor drawn inside an
 * embed. Reads see only the section's run of blocks as the document; every command
 * goes to the real workspace in one transaction, after which the section grows to
 * take in the blocks the command created next to it (Enter at the end of the run,
 * a block lifted out of a list), so edits made in an embed never leak out of it.
 * @param {any} host The real workspace.
 * @param {string} sectionId
 * @returns {any}
 */
export function createNestedStore(host, sectionId) {
  /** Grow the run over adjacent blocks that belong to it. */
  function fit(/** @type {Set<string>} */ belong) {
    const found = findSection(host.data, sectionId);
    if (!found) return;
    const { content } = found.container;
    const { startBlockId, endBlockId } = found.section.locator;
    const place = findContainer(content, startBlockId);
    if (!place) return;
    let first = place.index;
    let last = place.ids.indexOf(endBlockId);
    if (last < first) return;
    while (last + 1 < place.ids.length && belong.has(place.ids[last + 1])) last += 1;
    while (first > 0 && belong.has(place.ids[first - 1])) first -= 1;
    if (place.ids[first] !== startBlockId || place.ids[last] !== endBlockId) {
      host.dispatch("resizeSection", { sectionId, startBlockId: place.ids[first], endBlockId: place.ids[last] });
    }
  }

  return {
    events: { on: () => () => {} },
    get data() {
      return host.data;
    },
    getPage(/** @type {string} */ id) {
      const container = containerOf(host.data, id);
      if (!container) return undefined;
      const found = findSection(host.data, sectionId);
      const blockOrder = found && found.containerId === id ? sectionRunIds(container.content, found.section.locator) : [];
      return { ...container, content: { ...container.content, blockOrder } };
    },
    transact: (/** @type {string} */ label, /** @type {() => any} */ fn) => host.transact(label, fn),
    dispatch(/** @type {string} */ type, /** @type {any} */ payload, /** @type {any} */ dispatchOptions) {
      return host.transact(type, () => {
        const found = findSection(host.data, sectionId);
        const before = new Set(found ? Object.keys(found.container.content.blocks ?? {}) : []);
        const belong = new Set(found ? sectionBlockIds(found.container.content, found.section.locator) : []);
        const result = host.dispatch(type, payload, dispatchOptions);
        const after = findSection(host.data, sectionId);
        if (after) for (const id of Object.keys(after.container.content.blocks ?? {})) if (!before.has(id)) belong.add(id);
        fit(belong);
        return result;
      });
    }
  };
}
