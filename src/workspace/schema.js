/**
 * Versioned workspace JSON schema (spec §4, §12).
 *
 * The canonical serialized format is the `YourOffice-workspace` JSON object with a
 * `schemaVersion`. Validation is a separate exported function so imports, migrations,
 * and tests all exercise the same code path.
 */

import { validateReferences } from "../references/integrity.js";

/** @typedef {"document" | "sheet" | "presentation"} PageType */

/** @type {"YourOffice-workspace"} */
export const WORKSPACE_FORMAT = "YourOffice-workspace";

export const SCHEMA_VERSION = 1;

/** @type {PageType[]} Initial page types. */
export const PAGE_TYPES = ["document", "sheet", "presentation"];

const ISO_8601_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A page envelope: identity + metadata, with type-specific content below it.
 *
 * @typedef {object} PageEnvelope
 * @property {string} id Stable ID; equals its key in `pages`.
 * @property {PageType} type
 * @property {string} title
 * @property {string} createdAt ISO 8601 UTC.
 * @property {string} modifiedAt ISO 8601 UTC.
 * @property {Record<string, unknown>} [content] Type-specific content (per editor).
 */

/**
 * Full serialized workspace document.
 *
 * @typedef {object} WorkspaceDocument
 * @property {"YourOffice-workspace"} format
 * @property {number} schemaVersion
 * @property {{ id: string, title: string, createdAt: string, modifiedAt: string }} metadata
 * @property {Record<string, PageEnvelope>} pages
 * @property {{ root: string[], [parentId: string]: string[] }} pageOrder
 *    root plus an ordered child list per parent page id.
 * @property {Record<string, unknown>} settings
 * @property {Record<string, unknown>} [detached] Content that lost its place but is still read (see references/detached.js).
 */

/**
 * @typedef {object} ValidationErrors
 * @property {string[]} errors Human-readable problem list; empty when valid.
 * @property {boolean} valid
 */

/**
 * Check whether a value is a plain object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isIsoUtc(value) {
  return typeof value === "string" && ISO_8601_UTC.test(value);
}

/**
 * Push every string element of an array of ids that fails `exists` onto `errors`.
 * @param {unknown} list
 * @param {(id: unknown) => boolean} exists
 * @param {string} what
 * @param {string[]} errors
 * @returns {string[]} the list when usable, else []
 */
function checkIdList(list, exists, what, errors) {
  if (!Array.isArray(list) || list.some((id) => typeof id !== "string")) {
    errors.push(`pageOrder: ${what} must be an array of string ids`);
    return [];
  }
  const ids = /** @type {string[]} */ (list);
  const unique = new Set();
  for (const id of ids) {
    if (unique.has(id)) {
      errors.push(`pageOrder: ${what} contains duplicate id "${id}"`);
    }
    unique.add(id);
    if (!exists(id)) {
      errors.push(`pageOrder: ${what} references unknown page "${id}"`);
    }
  }
  return ids;
}

/**
 * Validate a workspace JSON document against the current schema.
 * Pure: takes any parsed JSON, returns an error list. Never throws.
 *
 * @param {unknown} data Parsed JSON of unknown shape.
 * @returns {ValidationErrors}
 */
export function validateWorkspace(data) {
  /** @type {string[]} */
  const errors = [];

  if (!isPlainObject(data)) {
    return { valid: false, errors: ["workspace must be a JSON object"] };
  }

  if (data.format !== WORKSPACE_FORMAT) {
    errors.push(`format must be "${WORKSPACE_FORMAT}"`);
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(data.schemaVersion)}`
    );
  }

  const metadata = data.metadata;
  if (!isPlainObject(metadata)) {
    errors.push("metadata must be an object");
  } else {
    for (const field of ["id", "title", "createdAt", "modifiedAt"]) {
      const value = metadata[field];
      if (field === "id" || field === "title") {
        if (typeof value !== "string" || value.length === 0) {
          errors.push(`metadata.${field} must be a non-empty string`);
        }
      } else if (!isIsoUtc(value)) {
        errors.push(`metadata.${field} must be an ISO 8601 UTC datetime`);
      }
    }
  }

  const pages = data.pages;
  if (!isPlainObject(pages)) {
    errors.push("pages must be an object");
  } else {
    for (const [id, envelope] of Object.entries(pages)) {
      if (!isPlainObject(envelope)) {
        errors.push(`pages["${id}"] must be an object`);
        continue;
      }
      if (envelope.id !== id) {
        errors.push(`pages["${id}"].id must match its key`);
      }
      if (!PAGE_TYPES.includes(/** @type {PageType} */ (envelope.type))) {
        errors.push(`pages["${id}"].type must be one of ${PAGE_TYPES.join(", ")}`);
      }
      if (typeof envelope.title !== "string") {
        errors.push(`pages["${id}"].title must be a string`);
      }
      if (!isIsoUtc(envelope.createdAt)) {
        errors.push(`pages["${id}"].createdAt must be an ISO 8601 UTC datetime`);
      }
      if (!isIsoUtc(envelope.modifiedAt)) {
        errors.push(`pages["${id}"].modifiedAt must be an ISO 8601 UTC datetime`);
      }
    }
  }

  const pageOrder = data.pageOrder;
  if (!isPlainObject(pageOrder)) {
    errors.push("pageOrder must be an object with a root list");
    return { valid: errors.length === 0, errors };
  }

  const pagesExists = isPlainObject(pages)
    ? (id) => isPlainObject(pages) && Object.prototype.hasOwnProperty.call(pages, id)
    : () => false;

  /** @type {string[]} */
  const rootIds = checkIdList(pageOrder.root, pagesExists, "root", errors);

  /** @type {Map<string, string|null>} parent of each listed page */
  const parentOf = new Map(rootIds.map((id) => [id, /** @type {string|null} */ (null)]));

  for (const [parentId, children] of Object.entries(pageOrder)) {
    if (parentId === "root") continue;
    if (!pagesExists(parentId)) {
      errors.push(`pageOrder["${parentId}"] is keyed by an unknown page`);
      continue;
    }
    const childIds = checkIdList(children, pagesExists, `"${parentId}" children`, errors);
    for (const childId of childIds) {
      if (parentOf.has(childId)) {
        errors.push(
          `pageOrder: page "${childId}" is listed as a child of more than one parent`
        );
      }
      parentOf.set(childId, parentId);
    }
  }

  // Every page must appear in the hierarchy exactly once.
  if (isPlainObject(pages)) {
    for (const id of Object.keys(pages)) {
      if (!parentOf.has(id)) {
        errors.push(`pageOrder: page "${id}" is not reachable in the hierarchy`);
      }
    }
  }

  // Walk up from each page to detect parent cycles not anchored at root.
  const pageCount = isPlainObject(pages) ? Object.keys(pages).length : 0;
  let cyclic = false;
  for (const id of parentOf.keys()) {
    if (cyclic) break;
    const seen = new Set([id]);
    let cursor = parentOf.get(id) ?? null;
    let steps = 0;
    while (cursor !== null && steps <= pageCount) {
      if (seen.has(cursor)) {
        errors.push(`pageOrder: page "${id}" is in a parent cycle`);
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
      steps += 1;
    }
  }

  if (data.settings !== undefined && !isPlainObject(data.settings)) {
    errors.push("settings must be an object when present");
  } else if (data.settings?.favoritePageIds !== undefined) {
    const ids = data.settings.favoritePageIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      errors.push("settings.favoritePageIds must be an array of page ids when present");
    }
  }

  // Sections, detached content and the references between them (only once the envelope is sound).
  if (errors.length === 0) errors.push(...validateReferences(data));

  return { valid: errors.length === 0, errors };
}

/**
 * @typedef {object} Migration
 * @property {number} from
 * @property {number} to
 * @property {(data: Record<string, unknown>) => Record<string, unknown>} up
 */

/** Registered migrations, oldest first. Empty until schema v2 exists. */
export const migrations = /** @type {Migration[]} */ ([]);

/**
 * Bring a workspace JSON document up to the current schema version.
 * Tolerates the same shape multiple times (idempotent) and passes out errors it
 * could not resolve.
 *
 * @param {unknown} data
 * @returns {{ data: WorkspaceDocument | null, appliedMigrationSteps: number, errors: string[] }}
 */
export function migrateWorkspace(data) {
  if (!isPlainObject(data)) {
    return { data: null, appliedMigrationSteps: 0, errors: ["workspace must be a JSON object"] };
  }
  let current = /** @type {Record<string, unknown>} */ ({ ...data });
  let version = typeof current.schemaVersion === "number" ? current.schemaVersion : 0;
  let steps = 0;
  for (const migration of migrations) {
    if (version === migration.from) {
      current = migration.up(current);
      current.schemaVersion = migration.to;
      version = migration.to;
      steps += 1;
    }
  }
  if (version !== SCHEMA_VERSION) {
    return {
      data: null,
      appliedMigrationSteps: steps,
      errors: [
        `no migration path from schemaVersion ${version} to ${SCHEMA_VERSION}`
      ]
    };
  }
  const check = validateWorkspace(current);
  if (!check.valid) {
    return { data: null, appliedMigrationSteps: steps, errors: check.errors };
  }
  return {
    data: /** @type {WorkspaceDocument} */ (current),
    appliedMigrationSteps: steps,
    errors: []
  };
}
