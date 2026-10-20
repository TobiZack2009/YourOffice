/**
 * The shared pieces behind handles: the small grip / link / function controls that
 * make a section, move it, or manage a reference.
 *
 * Nothing here knows which editor opened it. Callers pass the workspace, a popover
 * host and an anchor; the menus return `MenuItem[]` for `buildMenu`, and actions go
 * through `guard` so a refused command shows a notice instead of failing silently.
 */

import { createId } from "../core/ids.js";
import { containerOf } from "../references/containers.js";
import { findReferenceHost } from "../references/hosts.js";
import { countReferences, referencesTo } from "../references/index.js";
import { findSection } from "../references/sections.js";
import { formatA1 } from "../sheet/references.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { guard as defaultGuard } from "./notice.js";
import { buildMenu } from "./popover.js";

/**
 * Where a drag of blocks should land. Pure so the rules are testable without events.
 * @param {string[]} order Top-level block ids, in order.
 * @param {string[]} ids Blocks being moved (any order).
 * @param {string} targetId A top-level block that is not being moved.
 * @param {"before" | "after"} side
 * @returns {{ blockIds: string[], afterBlockId?: string, beforeBlockId?: string } | null} Null when the move changes nothing.
 */
export function planBlockMove(order, ids, targetId, side) {
  const moving = new Set(ids);
  if (moving.size === 0 || moving.has(targetId) || !order.includes(targetId)) return null;
  const blockIds = order.filter((id) => moving.has(id));
  if (blockIds.length !== moving.size) return null;
  // Order after the move, to detect a no-op.
  const rest = order.filter((id) => !moving.has(id));
  const at = rest.indexOf(targetId) + (side === "after" ? 1 : 0);
  const next = [...rest.slice(0, at), ...blockIds, ...rest.slice(at)];
  if (next.every((id, index) => id === order[index])) return null;
  return side === "after" ? { blockIds, afterBlockId: targetId } : { blockIds, beforeBlockId: targetId };
}

/**
 * Ask for a name in a small popover.
 * @param {import("./popover.js").PopoverHost} popovers
 * @param {HTMLElement} anchor
 * @param {{ title: string, initial?: string, confirm?: string, onSubmit: (name: string) => boolean | void }} options
 *   `onSubmit` returns false to keep the prompt open (after reporting why itself).
 */
export function promptName(popovers, anchor, options) {
  const input = /** @type {HTMLInputElement} */ (
    h("input", { class: "name-prompt-input", type: "text", value: options.initial ?? "", "aria-label": options.title })
  );
  const submit = () => {
    const name = input.value.trim();
    if (name === "") {
      input.classList.add("is-invalid");
      return;
    }
    if (options.onSubmit(name) === false) return;
    popovers.close();
  };
  const form = h("div", { class: "name-prompt" }, [
    h("div", { class: "name-prompt-title", text: options.title }),
    input,
    h("div", { class: "name-prompt-actions" }, [
      h("button", { class: "button is-primary", type: "button", "data-action": "name-confirm", text: options.confirm ?? "Save", onClick: submit })
    ])
  ]);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      popovers.close();
    }
    event.stopPropagation();
  });
  input.addEventListener("input", () => input.classList.remove("is-invalid"));
  popovers.show(anchor, form, { keepFocus: true, class: "name-prompt-popover" });
  input.select();
}

/**
 * A readable name for where a reading site sits.
 * @param {any} data
 * @param {import("../references/index.js").ReferenceSite} site
 * @returns {string}
 */
export function describeSite(data, site) {
  const container = containerOf(data, site.containerId);
  const title = container?.title || container?.origin?.title || "Untitled";
  const where = !data.pages?.[site.containerId] ? " (kept copy)" : "";
  if (site.source === "formula") {
    const table = container?.content?.tables?.[site.tableId ?? ""];
    const cell = site.position ? formatA1({ col: site.position.col + 1, row: site.position.row + 1 }) : "";
    return `${title}${where}: formula in ${table?.name ?? "table"} ${cell}`.trim();
  }
  return `${title}${where}: ${site.source === "embed" ? "embed" : "expression"}`;
}

/**
 * List what reads a section, each row going to the page that holds it.
 * @param {object} ctx
 * @param {{ data: any }} ctx.workspace
 * @param {import("./popover.js").PopoverHost} ctx.popovers
 * @param {HTMLElement} ctx.anchor
 * @param {string} ctx.sectionId
 * @param {(pageId: string) => void} [ctx.navigate]
 */
export function showReferenceList(ctx) {
  const data = ctx.workspace.data;
  const sites = referencesTo(data, [`sec:${ctx.sectionId}`]);
  const list = h("div", { class: "reference-list", role: "list" });
  if (sites.length === 0) list.append(h("div", { class: "reference-list-empty", text: "Nothing refers to this yet." }));
  for (const site of sites) {
    const row = h("button", { class: "reference-list-row", type: "button", role: "listitem", "data-container-id": site.containerId });
    row.append(h("span", { class: "reference-list-text", text: describeSite(data, site) }));
    row.addEventListener("click", () => {
      ctx.popovers.close();
      if (data.pages?.[site.containerId]) ctx.navigate?.(site.containerId);
    });
    list.append(row);
  }
  ctx.popovers.show(ctx.anchor, h("div", { class: "reference-list-popover" }, [h("div", { class: "name-prompt-title", text: `Used in ${sites.length}` }), list]), {
    class: "reference-list-host"
  });
}

/**
 * Menu entries for a section the user can see (the source side).
 * @param {object} ctx
 * @param {{ data: any, dispatch: Function, transact: Function }} ctx.workspace
 * @param {import("./popover.js").PopoverHost} ctx.popovers
 * @param {() => HTMLElement} ctx.anchor Where follow-up popovers open.
 * @param {string} ctx.sectionId
 * @param {(pageId: string) => void} [ctx.navigate]
 * @returns {import("./popover.js").MenuItem[]}
 */
export function sectionMenuItems(ctx) {
  const found = findSection(ctx.workspace.data, ctx.sectionId);
  if (!found) return [];
  const count = countReferences(ctx.workspace.data, [`sec:${ctx.sectionId}`]);
  return [
    {
      label: "Rename section",
      icon: "rename",
      attrs: { "data-action": "section-rename" },
      action: () =>
        promptName(ctx.popovers, ctx.anchor(), {
          title: "Section name",
          initial: found.section.name ?? "",
          onSubmit: (name) => (ctx.guard ?? defaultGuard)(() => ctx.workspace.dispatch("renameSection", { sectionId: ctx.sectionId, name }))
        })
    },
    {
      label: `Show references (${count})`,
      icon: "link",
      attrs: { "data-action": "section-references" },
      action: () => showReferenceList({ ...ctx, anchor: ctx.anchor() })
    },
    {
      label: "Remove section",
      icon: "trash",
      danger: true,
      attrs: { "data-action": "section-remove" },
      action: () => void (ctx.guard ?? defaultGuard)(() => ctx.workspace.dispatch("removeSection", { sectionId: ctx.sectionId }))
    }
  ];
}

/**
 * Menu entries for one reference instance (the embed / expression side).
 * @param {object} ctx
 * @param {{ data: any, dispatch: Function, transact: Function }} ctx.workspace
 * @param {import("./popover.js").PopoverHost} ctx.popovers
 * @param {() => HTMLElement} ctx.anchor
 * @param {string} ctx.hostId Container the reference sits in.
 * @param {any} ctx.record The reference block / object / inline ref.
 * @param {(pageId: string) => void} [ctx.navigate]
 * @param {(record: any) => void} [ctx.editExpression]
 * @param {(record: any) => void} [ctx.replaceSource]
 * @returns {import("./popover.js").MenuItem[]}
 */
export function referenceMenuItems(ctx) {
  const data = ctx.workspace.data;
  const { record } = ctx;
  /** @type {import("./popover.js").MenuItem[]} */
  const items = [];
  const remove = {
    label: "Remove reference",
    icon: "trash",
    danger: true,
    attrs: { "data-action": "reference-remove" },
    action: () => void (ctx.guard ?? defaultGuard)(() => ctx.workspace.dispatch("removeReference", { pageId: ctx.hostId, instanceId: record.id }))
  };

  if (record.kind === "expression") {
    items.push({
      label: "Edit expression",
      icon: "expression",
      attrs: { "data-action": "reference-edit" },
      action: () => ctx.editExpression?.(record)
    });
    items.push(remove);
    return items;
  }

  const found = record.sectionId ? findSection(data, record.sectionId) : null;
  if (found && !found.detached) {
    items.push({
      label: "Go to source",
      icon: "go-to",
      attrs: { "data-action": "reference-go" },
      action: () => ctx.navigate?.(found.containerId)
    });
  }
  if (found?.detached) {
    const entry = data.detached?.[found.containerId];
    const origin = entry?.origin?.pageId;
    const restorable = Boolean(origin && data.pages?.[origin] && data.pages[origin].type === entry.type);
    items.push({
      label: "Restore source to its page",
      icon: "unlink",
      disabled: !restorable,
      attrs: { "data-action": "reference-restore" },
      action: () =>
        void (ctx.guard ?? defaultGuard)(() => ctx.workspace.dispatch("restoreDetached", { detachedId: found.containerId, pageId: origin }))
    });
  }
  if (ctx.replaceSource) {
    items.push({
      label: "Choose another source",
      icon: "section",
      attrs: { "data-action": "reference-replace" },
      action: () => ctx.replaceSource?.(record)
    });
  }
  items.push({ separator: true }, remove);
  return items;
}

/**
 * Show a menu under an anchor.
 * @param {import("./popover.js").PopoverHost} popovers
 * @param {HTMLElement} anchor
 * @param {import("./popover.js").MenuItem[]} items
 */
export function showMenu(popovers, anchor, items) {
  popovers.show(anchor, buildMenu(items, popovers.close, (name) => icon(name, { size: 16 })), { class: "context-menu" });
}

/**
 * The badge a source carries: how many places read it.
 * @param {{ data: any }} workspace
 * @param {string} sectionId
 * @returns {number}
 */
export function referenceCount(workspace, sectionId) {
  return countReferences(workspace.data, [`sec:${sectionId}`]);
}

/** @returns {string} A fresh section id. */
export function newSectionId() {
  return createId("section");
}

export { findReferenceHost };
