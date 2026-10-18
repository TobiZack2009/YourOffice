/**
 * Reference hosts: the places a reference instance can live.
 *
 *   document      a `sectionRef` block, or an inline `{ ref }` run in a block's / list item's runs
 *   presentation  a `reference` object, or an inline `{ ref }` run in a text object
 *   sheet         none (embedding into sheets is not supported)
 *
 * An instance is `{ id, kind: "embed" | "expression", sectionId?, expression?, display? }`.
 * For blocks and objects the fields sit on the block/object itself (the block id is
 * the instance id); for inline runs they sit in `run.ref`.
 *
 * `walkReferenceHosts` is the single scan every consumer shares (the reverse index,
 * expression rewriting, integrity checks, detach/sweep), so a new host type is added here once.
 */

import { allContainers } from "./containers.js";

/**
 * @typedef {object} ReferenceHost
 * @property {string} containerId Page or detached id that holds the instance.
 * @property {string} instanceId
 * @property {"embed" | "expression"} kind
 * @property {string | undefined} sectionId Embeds: the section shown.
 * @property {string | undefined} expression Expressions: the source text.
 * @property {{ blockId?: string, slideId?: string, objectId?: string, itemId?: string, inline: boolean }} where
 * @property {any} record The object that carries `kind` / `sectionId` / `expression` / `display`.
 */

/**
 * @param {any} record
 * @returns {"embed" | "expression"}
 */
function kindOf(record) {
  return record?.kind === "expression" ? "expression" : "embed";
}

/**
 * @param {string} containerId
 * @param {any} record
 * @param {ReferenceHost["where"]} where
 * @param {string} instanceId
 * @returns {ReferenceHost}
 */
function host(containerId, record, where, instanceId) {
  return {
    containerId,
    instanceId,
    kind: kindOf(record),
    sectionId: record.sectionId,
    expression: record.expression,
    where,
    record
  };
}

/**
 * @param {any[] | undefined} runs
 * @returns {any[]} The `ref` records inside the runs.
 */
export function inlineRefs(runs) {
  return Array.isArray(runs) ? runs.filter((run) => run && run.ref && typeof run.ref === "object").map((run) => run.ref) : [];
}

/**
 * Visit every reference instance in the workspace, live pages and detached entries.
 * @param {import("./containers.js").ContainerData} data
 * @param {(host: ReferenceHost) => void} visit
 */
export function walkReferenceHosts(data, visit) {
  for (const [containerId, container] of allContainers(data)) {
    const content = container?.content;
    if (!content) continue;
    if (container.type === "document" && content.blocks) {
      for (const block of Object.values(/** @type {Record<string, any>} */ (content.blocks))) {
        if (block.type === "sectionRef") {
          visit(host(containerId, block, { blockId: block.id, inline: false }, block.id));
        }
        for (const ref of inlineRefs(block.runs)) {
          visit(host(containerId, ref, { blockId: block.id, inline: true }, ref.id));
        }
        for (const item of block.items ?? []) {
          for (const ref of inlineRefs(item.runs)) {
            visit(host(containerId, ref, { blockId: block.id, itemId: item.id, inline: true }, ref.id));
          }
        }
      }
    } else if (container.type === "presentation" && content.slides) {
      for (const [slideId, slide] of Object.entries(/** @type {Record<string, any>} */ (content.slides))) {
        for (const object of Object.values(/** @type {Record<string, any>} */ (slide.objects ?? {}))) {
          if (object.type === "reference") {
            visit(host(containerId, object, { slideId, objectId: object.id, inline: false }, object.id));
          }
          for (const ref of inlineRefs(object.text?.runs)) {
            visit(host(containerId, ref, { slideId, objectId: object.id, inline: true }, ref.id));
          }
        }
      }
    }
  }
}

/**
 * Find one instance by id.
 * @param {import("./containers.js").ContainerData} data
 * @param {string} instanceId
 * @param {string} [containerId] Narrow the scan to one container.
 * @returns {ReferenceHost | null}
 */
export function findReferenceHost(data, instanceId, containerId) {
  /** @type {ReferenceHost | null} */
  let found = null;
  walkReferenceHosts(data, (candidate) => {
    if (!found && candidate.instanceId === instanceId && (!containerId || candidate.containerId === containerId)) {
      found = candidate;
    }
  });
  return found;
}
