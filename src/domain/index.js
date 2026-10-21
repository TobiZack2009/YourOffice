/**
 * The composition root of the model. `workspace/` knows pages, history and commands but
 * nothing about what a page holds; this module wires the features into it: every command set,
 * the hooks that keep sections and references honest, the content validators and the integrity
 * check. The app, `main.js` and tests build workspaces through here.
 *
 *   const workspace = createWorkspace({ title: "Mine" });   // fully installed
 *   const restored  = workspaceFromJSON(parsed);             // validated by the full rules
 */

import { Workspace } from "../workspace/store.js";
import { validateWorkspace } from "../workspace/schema.js";
import { exportWorkspaceJSON as exportJSON, importWorkspaceJSON as importJSON } from "../workspace/format.js";
import { registerDocumentCommands } from "../document/commands.js";
import { validateDocumentContent } from "../document/model.js";
import { registerSheetCommands } from "../sheet/commands.js";
import { validateSheetContent } from "../calc/model.js";
import { registerPresentationCommands } from "../presentation/commands.js";
import { validatePresentationContent } from "../presentation/model.js";
import { moveImagesToAssets } from "../presentation/migrate.js";
import { validateAssetReferences } from "../workspace/assets.js";
import { registerReferenceCommands } from "../references/commands.js";
import { validateReferences } from "../references/integrity.js";

/** @typedef {import("../workspace/schema.js").ValidationOptions} ValidationOptions */

/** The full rule set: per-type content validators and cross-page integrity. */
/** @type {ValidationOptions} */
export const domainValidation = Object.freeze({
  contentValidators: Object.freeze({
    document: validateDocumentContent,
    sheet: validateSheetContent,
    presentation: validatePresentationContent
  }),
  integrityChecks: Object.freeze([validateReferences, validateAssetReferences]),
  migrations: Object.freeze([{ from: 1, to: 2, up: moveImagesToAssets }])
});

/** @type {WeakSet<Workspace>} */
const installed = new WeakSet();

/**
 * Register every feature on a workspace. Idempotent.
 * @template {Workspace} W
 * @param {W} workspace
 * @returns {W}
 */
export function installDomain(workspace) {
  if (installed.has(workspace)) return workspace;
  installed.add(workspace);
  workspace.configureValidation(domainValidation);
  registerDocumentCommands(workspace);
  registerSheetCommands(workspace);
  registerPresentationCommands(workspace);
  registerReferenceCommands(workspace);
  return workspace;
}

/**
 * A new, empty, fully installed workspace.
 * @param {{ title?: string }} [options]
 * @returns {Workspace}
 */
export function createWorkspace(options = {}) {
  return installDomain(Workspace.create(options));
}

/**
 * Rehydrate and install a workspace from parsed JSON, checked by the full rules.
 * @param {unknown} json
 * @returns {Workspace}
 * @throws {import("../core/errors.js").WorkspaceFormatError}
 */
export function workspaceFromJSON(json) {
  return installDomain(Workspace.fromJSON(json, { validation: domainValidation }));
}

/**
 * Parse, validate (full rules), migrate and install workspace JSON text.
 * @param {string} text
 * @returns {Workspace}
 * @throws {import("../core/errors.js").WorkspaceFormatError}
 */
export function importWorkspaceJSON(text) {
  return importJSON(text, { validation: domainValidation, install: installDomain });
}

/** Export validates against the rules the workspace was configured with. */
export const exportWorkspaceJSON = exportJSON;

/**
 * Check a serialized workspace against the full rules.
 * @param {unknown} data
 * @returns {import("../workspace/schema.js").ValidationErrors}
 */
export function validateDomain(data) {
  return validateWorkspace(data, domainValidation);
}
