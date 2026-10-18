/**
 * Integrity of sections, the detached store and the references between them.
 *
 * `validateWorkspace` calls this once the envelope itself is sound, so imports reject
 * workspaces whose sections point at nothing or whose references loop. A reference to a
 * section that no longer exists is NOT an error: it renders as "source removed".
 */

import { allContainers } from "./containers.js";
import { findReferenceCycle } from "./index.js";
import { locatorProblem } from "./sections.js";

const DETACHED_TYPES = ["document", "sheet", "presentation"];

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {any} data A workspace document whose envelope already validated.
 * @returns {string[]} Problems found (empty when fine).
 */
export function validateReferences(data) {
  /** @type {string[]} */
  const errors = [];

  if (data.detached !== undefined) {
    if (!isObject(data.detached)) {
      errors.push("detached must be an object when present");
    } else {
      for (const [id, entry] of Object.entries(data.detached)) {
        if (!isObject(entry)) {
          errors.push(`detached["${id}"] must be an object`);
          continue;
        }
        if (entry.id !== id) errors.push(`detached["${id}"].id must match its key`);
        if (!DETACHED_TYPES.includes(entry.type)) errors.push(`detached["${id}"].type must be one of ${DETACHED_TYPES.join(", ")}`);
        if (!isObject(entry.origin) || typeof entry.origin.pageId !== "string") {
          errors.push(`detached["${id}"].origin.pageId must be a string`);
        }
        if (!isObject(entry.content)) errors.push(`detached["${id}"].content must be an object`);
        if (data.pages?.[id]) errors.push(`detached["${id}"] clashes with a page id`);
      }
    }
  }
  if (errors.length > 0) return errors;

  /** @type {Set<string>} */
  const seen = new Set();
  for (const [containerId, container] of allContainers(data)) {
    const sections = container?.content?.sections;
    if (sections === undefined) continue;
    if (!isObject(sections)) {
      errors.push(`"${containerId}": sections must be an object`);
      continue;
    }
    for (const [id, section] of Object.entries(sections)) {
      const label = `"${containerId}" section "${id}"`;
      if (!isObject(section) || section.id !== id) {
        errors.push(`${label}: id must match its key`);
        continue;
      }
      if (seen.has(id)) errors.push(`${label}: id is used by more than one section`);
      seen.add(id);
      if (section.name !== undefined && (typeof section.name !== "string" || section.name === "")) {
        errors.push(`${label}: name must be a non-empty string when present`);
      }
      if (section.name === undefined && section.implicit !== true) {
        errors.push(`${label}: a section without a name must be implicit`);
      }
      const problem = locatorProblem(container, section.locator);
      if (problem) errors.push(`${label}: ${problem}`);
    }
  }
  if (errors.length > 0) return errors;

  if (findReferenceCycle(data)) errors.push("references: content shows itself through a loop of embeds or expressions");
  return errors;
}
