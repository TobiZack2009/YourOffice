/**
 * Reference commands, and the hooks that keep sections and the detached store honest.
 *
 * Commands (all undoable, all one transaction):
 *   createSection, renameSection, removeSection
 *   insertReference, updateReference, setExpression, removeReference
 *   restoreDetached
 *
 * Hooks (registered with `registerReferenceCommands`, run around EVERY command):
 *   before  note what sections cover (`captureSections`)
 *   after   re-fit sections, detach vanished content, sweep unread detached entries,
 *           and refuse a command that would make content show itself
 *
 * Callers pass their own ids (`sectionId`, `instanceId`) because commands return nothing.
 */

import { createId } from "../core/ids.js";
import { CommandError } from "../core/errors.js";
import { nameProblem } from "../sheet/names.js";
import { touchContainer } from "../workspace/commands.js";
import { documentCommands } from "../document/commands.js";
import { presentationCommands } from "../presentation/commands.js";
import { createObject, createTextBody } from "../presentation/model.js";
import { REF_CHAR, validateReferenceFields } from "../document/model.js";
import { insertRunAt } from "../document/runs.js";
import { containerOf, scopePageOf } from "./containers.js";
import { captureSections, healSections } from "./healing.js";
import { addDetached, copySectionContent, restoreInto, sweepDetached } from "./detached.js";
import { findReferenceHost } from "./hosts.js";
import { countReferences, findReferenceCycle, validateReference } from "./index.js";
import { retargetReferences, snapshotReferences } from "./rewrite.js";
import { uniqueName } from "./scope.js";
import { findSection, locatorProblem } from "./sections.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/store.js").Transaction} Transaction */

/** Page commands after which formula text that names pages must be respelled. */
const RESPELLING_COMMANDS = new Set(["createPage", "renamePage", "movePage"]);

/** Registration facts of reference commands: `resizeSection` does its own section bookkeeping. */
const COMMAND_META = { resizeSection: { selfManaged: true } };

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireId(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new CommandError(`${field} must be a non-empty string`, "invalidReference");
  }
  return value;
}

/**
 * @param {Workspace} store
 * @param {unknown} id
 * @returns {{ id: string, container: any }}
 */
function requireContainer(store, id) {
  const containerId = requireId(id, "pageId");
  const container = containerOf(store._data, containerId);
  if (!container) throw new CommandError(`page does not exist: ${containerId}`, "unknownPage");
  return { id: containerId, container };
}

/**
 * Names are unique within the page that owns them (detached content borrows its origin page).
 * @param {Workspace} store
 * @param {string} containerId
 * @param {string} name
 * @param {string} [exceptId]
 * @returns {string}
 */
function nameFor(store, containerId, name, exceptId) {
  const problem = nameProblem(name);
  if (problem) throw new CommandError(problem, "invalidName");
  const scope = scopePageOf(store._data, containerId);
  return scope === null ? name : uniqueName(store._data, scope, name, exceptId);
}

/**
 * @param {Workspace} store
 * @returns {boolean}
 */
function hasSections(store) {
  const data = store._data;
  for (const container of [...Object.values(data.pages), ...Object.values(data.detached ?? {})]) {
    const sections = /** @type {any} */ (container).content?.sections;
    if (sections && Object.keys(sections).length > 0) return true;
  }
  return false;
}

/**
 * Page ids of a page and everything under it.
 * @param {Workspace} store
 * @param {string} pageId
 * @returns {string[]}
 */
function subtree(store, pageId) {
  const out = [pageId];
  for (let i = 0; i < out.length; i++) out.push(...store.getChildren(out[i]));
  return out;
}

/**
 * Throw when a reference instance that already sits in the workspace is not acceptable.
 * @param {Workspace} store
 * @param {string} containerId
 * @param {string} instanceId
 */
function assertReferenceValid(store, containerId, instanceId) {
  const host = findReferenceHost(store._data, instanceId, containerId);
  if (!host) throw new CommandError("That reference does not exist.", "unknownReference");
  const verdict = validateReference(store._data, host);
  if (!verdict.ok) throw new CommandError(verdict.message ?? "That reference is not valid.", "invalidReference");
}

/**
 * The fields an inline reference carries (no undefined keys).
 * @param {{ kind: string, sectionId?: string, expression?: string, display?: Record<string, any> }} fields
 */
function refFields(fields) {
  return {
    kind: fields.kind,
    ...(fields.sectionId ? { sectionId: fields.sectionId } : {}),
    ...(fields.expression !== undefined ? { expression: fields.expression } : {}),
    display: fields.display ?? {}
  };
}

/**
 * Put a reference run into the runs of a block, list item or text object.
 * @param {any} container Live page.
 * @param {{ blockId?: string, itemId?: string, slideId?: string, objectId?: string, offset?: number }} site
 * @param {any} run
 */
function placeInline(container, site, run) {
  const offset = Number.isInteger(site?.offset) && site.offset >= 0 ? site.offset : Number.MAX_SAFE_INTEGER;
  if (container.type === "document") {
    const block = container.content.blocks?.[site?.blockId ?? ""];
    if (!block) throw new CommandError("That block does not exist.", "unknownBlock");
    if (block.type === "list" && site.itemId) {
      const item = block.items?.find((/** @type {any} */ candidate) => candidate.id === site.itemId);
      if (!item) throw new CommandError("That list item does not exist.", "unknownBlock");
      item.runs = insertRunAt(item.runs ?? [], offset, run);
    } else if (block.type === "paragraph" || block.type === "heading" || block.type === "quote") {
      block.runs = insertRunAt(block.runs ?? [], offset, run);
    } else {
      throw new CommandError(`A ${block.type} block cannot hold an inline reference.`, "invalidReference");
    }
    return;
  }
  if (container.type === "presentation") {
    const object = container.content.slides?.[site?.slideId ?? ""]?.objects?.[site?.objectId ?? ""];
    if (!object) throw new CommandError("That object does not exist.", "unknownObject");
    if (object.type !== "text" && object.type !== "shape") {
      throw new CommandError(`A ${object.type} object cannot hold an inline reference.`, "invalidReference");
    }
    object.text ??= createTextBody({ align: "center", valign: "middle" });
    object.text.runs = insertRunAt(object.text.runs ?? [], offset, run);
    return;
  }
  throw new CommandError("References cannot be placed inside a sheet yet; use a formula there.", "invalidReference");
}

/** @type {Record<string, (store: Workspace, tx: Transaction, payload: any) => void>} */
export const referenceCommands = {
  /**
   * Name a piece of a page so it can be shown or read elsewhere.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, locator: Record<string, any>, name?: string, sectionId?: string, implicit?: boolean }} payload
   */
  createSection(store, tx, payload) {
    const p = payload ?? {};
    const { id: containerId, container } = requireContainer(store, p.pageId);
    const problem = locatorProblem(container, p.locator);
    if (problem) throw new CommandError(problem, "invalidLocator");
    const sectionId = p.sectionId === undefined ? createId("section") : requireId(p.sectionId, "sectionId");
    if (findSection(store._data, sectionId)) {
      throw new CommandError(`section already exists: ${sectionId}`, "duplicateSection");
    }
    const hasName = typeof p.name === "string" && p.name !== "";
    if (!hasName && p.implicit !== true) throw new CommandError("A section needs a name.", "invalidName");

    const snapshot = snapshotReferences(store._data);
    container.content.sections ??= {};
    container.content.sections[sectionId] = {
      id: sectionId,
      ...(hasName ? { name: nameFor(store, containerId, p.name ?? "") } : {}),
      ...(p.implicit === true ? { implicit: true } : {}),
      locator: structuredClone(p.locator)
    };
    touchContainer(store, tx, containerId);
    // A new name can start shadowing one that formulas already use.
    retargetReferences(store._data, snapshot, (id) => touchContainer(store, tx, id));
  },

  /**
   * Rename a section; every expression and formula that used the name is respelled.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ sectionId: string, name: string }} payload
   */
  renameSection(store, tx, payload) {
    const found = findSection(store._data, requireId(payload?.sectionId, "sectionId"));
    if (!found) throw new CommandError("That section does not exist.", "unknownSection");
    const name = nameFor(store, found.containerId, payload.name, found.section.id);
    if (found.section.name === name && !found.section.implicit) return;
    const snapshot = snapshotReferences(store._data);
    found.section.name = name;
    delete found.section.implicit;
    touchContainer(store, tx, found.containerId);
    retargetReferences(store._data, snapshot, (id) => touchContainer(store, tx, id));
  },

  /**
   * Change which blocks a document section covers (an editor growing the run it is editing).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ sectionId: string, startBlockId: string, endBlockId: string }} payload
   */
  resizeSection(store, tx, payload) {
    const found = findSection(store._data, requireId(payload?.sectionId, "sectionId"));
    if (!found) throw new CommandError("That section does not exist.", "unknownSection");
    const locator = {
      startBlockId: requireId(payload.startBlockId, "startBlockId"),
      endBlockId: requireId(payload.endBlockId, "endBlockId")
    };
    if (found.container.type !== "document") {
      throw new CommandError("Only a document section covers blocks.", "invalidLocator");
    }
    const problem = locatorProblem(found.container, locator);
    if (problem) throw new CommandError(problem, "invalidLocator");
    found.section.locator = locator;
    touchContainer(store, tx, found.containerId);
  },

  /**
   * Stop naming a piece of a page. The content stays where it is; anything that still shows
   * or reads the section keeps a copy of what it showed.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ sectionId: string }} payload
   */
  removeSection(store, tx, payload) {
    const found = findSection(store._data, requireId(payload?.sectionId, "sectionId"));
    if (!found) throw new CommandError("That section does not exist.", "unknownSection");
    const { container, containerId, section } = found;
    if (countReferences(store._data, [`sec:${section.id}`]) > 0) {
      const content = copySectionContent(container, section);
      if (content) {
        addDetached(store._data, {
          type: container.type,
          origin: { pageId: containerId, title: container.title ?? container.origin?.title ?? "" },
          content
        });
      }
    }
    delete container.content.sections[section.id];
    touchContainer(store, tx, containerId);
  },

  /**
   * Place a reference: a block in a document, an object on a slide. Fails (and changes
   * nothing) when the reference is not acceptable.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {Record<string, any>} payload `{ pageId, kind, sectionId? | expression?, display?, instanceId?, ...position }`
   */
  insertReference(store, tx, payload) {
    const p = payload ?? {};
    const { id: containerId, container } = requireContainer(store, p.pageId);
    const kind = p.kind === "expression" ? "expression" : "embed";
    const instanceId = p.instanceId === undefined ? createId(container.type === "presentation" ? "obj" : "block") : requireId(p.instanceId, "instanceId");
    const fields = { kind, sectionId: p.sectionId, expression: p.expression, display: p.display ?? {} };
    const errors = validateReferenceFields(fields);
    if (errors.length > 0) throw new CommandError(errors.join("; "), "invalidReference");

    if (p.inline !== undefined) {
      placeInline(container, p.inline, { text: REF_CHAR, ref: { id: instanceId, ...refFields(fields) } });
      touchContainer(store, tx, containerId);
    } else if (container.type === "document") {
      const { sectionId, expression, ...rest } = fields;
      documentCommands.insertBlock(store, tx, {
        pageId: containerId,
        newBlockId: instanceId,
        block: { type: "sectionRef", ...rest, ...(sectionId ? { sectionId } : {}), ...(expression !== undefined ? { expression } : {}) },
        ...(p.index !== undefined ? { index: p.index } : {}),
        ...(p.afterBlockId !== undefined ? { afterBlockId: p.afterBlockId } : {}),
        ...(p.beforeBlockId !== undefined ? { beforeBlockId: p.beforeBlockId } : {}),
        ...(p.parent !== undefined ? { parent: p.parent } : {})
      });
    } else if (container.type === "presentation") {
      const object = createObject("reference", {
        id: instanceId,
        ...fields,
        x: p.x ?? 80,
        y: p.y ?? 80,
        width: p.width ?? 480,
        height: p.height ?? 270
      });
      presentationCommands.insertObject(store, tx, { pageId: containerId, slideId: p.slideId, object });
    } else {
      throw new CommandError("References cannot be placed inside a sheet yet; use a formula there.", "invalidReference");
    }
    assertReferenceValid(store, containerId, instanceId);
  },

  /**
   * Change what a reference shows (its section, its expression) or how (display options).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, instanceId: string, patch: { sectionId?: string, expression?: string, display?: Record<string, any> } }} payload
   */
  updateReference(store, tx, payload) {
    const { id: containerId } = requireContainer(store, payload?.pageId);
    const instanceId = requireId(payload?.instanceId, "instanceId");
    const host = findReferenceHost(store._data, instanceId, containerId);
    if (!host) throw new CommandError("That reference does not exist.", "unknownReference");
    const patch = payload.patch ?? {};
    const record = host.record;
    if (patch.sectionId !== undefined) {
      if (host.kind !== "embed") throw new CommandError("Only an embed shows a section.", "invalidReference");
      record.sectionId = requireId(patch.sectionId, "sectionId");
    }
    if (patch.expression !== undefined) {
      if (host.kind !== "expression") throw new CommandError("Only an expression has an expression.", "invalidReference");
      record.expression = String(patch.expression);
    }
    if (patch.display !== undefined) {
      if (typeof patch.display !== "object" || patch.display === null) {
        throw new CommandError("display must be an object", "invalidReference");
      }
      record.display = { ...(record.display ?? {}), ...structuredClone(patch.display) };
    }
    touchContainer(store, tx, containerId);
    assertReferenceValid(store, containerId, instanceId);
  },

  /**
   * Edit the expression of an expression reference (same checks as `updateReference`).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, instanceId: string, expression: string }} payload
   */
  setExpression(store, tx, payload) {
    referenceCommands.updateReference(store, tx, {
      pageId: payload?.pageId,
      instanceId: payload?.instanceId,
      patch: { expression: payload?.expression }
    });
  },

  /**
   * Take a reference away. What it showed is discarded with it when nothing else reads it.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, instanceId: string }} payload
   */
  removeReference(store, tx, payload) {
    const { id: containerId, container } = requireContainer(store, payload?.pageId);
    const instanceId = requireId(payload?.instanceId, "instanceId");
    const host = findReferenceHost(store._data, instanceId, containerId);
    if (!host) throw new CommandError("That reference does not exist.", "unknownReference");
    const { where } = host;
    if (!where.inline) {
      if (container.type === "document") {
        documentCommands.deleteBlock(store, tx, { pageId: containerId, blockId: instanceId });
      } else {
        presentationCommands.deleteObjects(store, tx, {
          pageId: containerId,
          slideId: where.slideId,
          objectIds: [instanceId]
        });
      }
      return;
    }
    /** @type {any[] | undefined} */
    let runs;
    if (container.type === "document") {
      const block = container.content.blocks[/** @type {string} */ (where.blockId)];
      runs = where.itemId ? block?.items?.find((/** @type {any} */ item) => item.id === where.itemId)?.runs : block?.runs;
    } else {
      runs = container.content.slides[/** @type {string} */ (where.slideId)]?.objects[/** @type {string} */ (where.objectId)]?.text?.runs;
    }
    if (!runs) throw new CommandError("That reference does not exist.", "unknownReference");
    const at = runs.findIndex((run) => run?.ref?.id === instanceId);
    if (at !== -1) runs.splice(at, 1);
    touchContainer(store, tx, containerId);
  },

  /**
   * Put detached content back on a page of the same kind. Its sections keep their ids, so every
   * reference carries on without being touched.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ detachedId: string, pageId: string }} payload
   */
  restoreDetached(store, tx, payload) {
    const detachedId = requireId(payload?.detachedId, "detachedId");
    const entry = store._data.detached?.[detachedId];
    if (!entry) throw new CommandError("That content is no longer kept.", "unknownDetached");
    const pageId = requireId(payload?.pageId, "pageId");
    const page = store._data.pages[pageId];
    if (!page) throw new CommandError(`page does not exist: ${pageId}`, "unknownPage");
    if (page.type !== entry.type) {
      throw new CommandError(`That content belongs on a ${entry.type} page.`, "typeMismatch");
    }
    const snapshot = snapshotReferences(store._data);
    restoreInto(store._data, detachedId, pageId, (desired, exceptId) => uniqueName(store._data, pageId, desired, exceptId));
    touchContainer(store, tx, pageId);
    retargetReferences(store._data, snapshot, (id) => touchContainer(store, tx, id));
  }
};

/**
 * Register the reference commands and the hooks around every command.
 * @param {Workspace} store
 */
export function registerReferenceCommands(store) {
  for (const [type, handler] of Object.entries(referenceCommands)) {
    if (!store.hasCommand(type)) store.registerCommand(type, handler, COMMAND_META[type]);
  }

  store.aroundCommand((workspace, tx, type, payload) => {
    const { hot, selfManaged } = workspace.commandMeta(type);
    const capture = hot || selfManaged ? null : captureSections(workspace._data);

    // A new page can start shadowing a name, and a rename or move changes which names are
    // visible from where: formulas are respelled once the handler has run.
    const respell = RESPELLING_COMMANDS.has(type) ? snapshotReferences(workspace._data) : null;

    // Deleting a page moves what other places still read into the detached store.
    /** @type {{ snapshot: ReturnType<typeof snapshotReferences>, doomed: Array<[string, any]> } | null} */
    let deleting = null;
    if (type === "deletePage") {
      const pageId = /** @type {any} */ (payload)?.pageId;
      if (typeof pageId === "string" && workspace._data.pages[pageId]) {
        deleting = {
          snapshot: snapshotReferences(workspace._data),
          doomed: subtree(workspace, pageId).map((id) => [id, workspace._data.pages[id]])
        };
      }
    }

    return () => {
      const data = workspace._data;
      const touch = (/** @type {string} */ id) => touchContainer(workspace, tx, id);
      if (respell) retargetReferences(data, respell, touch);
      if (deleting) {
        for (const [id, page] of deleting.doomed) {
          const content = page?.content;
          const keeps = page?.type === "sheet" ? Object.keys(content?.tables ?? {}).length > 0 : Object.keys(content?.sections ?? {}).length > 0;
          if (keeps) addDetached(data, { type: page.type, origin: { pageId: id, title: page.title ?? "" }, content });
        }
        sweepDetached(data);
        retargetReferences(data, deleting.snapshot, touch);
      }
      if (capture) healSections(data, capture, touch);
      if (data.detached) {
        sweepDetached(data);
        if (Object.keys(data.detached).length === 0) delete data.detached;
      }
      if (!hot && hasSections(workspace)) {
        const loop = findReferenceCycle(data);
        if (loop) {
          throw new CommandError("That would make content show itself, directly or through other references.", "referenceCycle");
        }
      }
    };
  });
}
