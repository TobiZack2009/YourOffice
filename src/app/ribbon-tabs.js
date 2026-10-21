/**
 * Ribbon structure: which tabs, groups and controls each page type shows.
 *
 * This module is data. `getTabs(pageType)` returns the tab list; `ribbon.js`
 * renders it and re-evaluates `enabled` / `active` against a context. Adding a
 * tab or a control is a data change here, not a change to the renderer.
 *
 * A control is
 *   { id, kind: "button" | "toggle" | "select" | "menu" | "field" | "color", label, icon,
 *     size: "large" | "small", title?, attrs?, action(ctx, element), enabled(ctx),
 *     active(ctx), disabledReason? }
 * - toggle: a button that can show an active state.
 * - select: `options`, `value(ctx)`, `action(ctx, value)`.
 * - menu: opens a popover from `items(ctx)` (menu rows) or `content(ctx, close)`.
 * - field: a number input that applies when committed (Enter or blur) — `value(ctx)`, `apply(ctx, number)`.
 * `attrs` are extra attributes on the rendered element; the stable `data-action`
 * / `data-type` / `data-level` / `data-mark` / `data-insert` hooks live there.
 *
 * - color: a native colour picker — `value(ctx)` (hex), `onSelect(ctx, hex)`.
 *
 * ctx is { workspace, page, docEditor, sheetEditor, presentationEditor, shell }.
 */

import { documentTabs } from "./ribbon-tabs-document.js";
import { workspaceSwitcher } from "./workspace-switcher.js";
import { button, hasPres, textPopover } from "./ribbon-shared.js";
import { sheetTabs } from "./ribbon-tabs-sheet.js";
import { presentationTabs } from "./ribbon-tabs-presentation.js";

export { THEME_REASON, EMBED_REASON } from "./ribbon-shared.js";
/** @typedef {import("./ribbon-shared.js").RibbonContext} RibbonContext */
/** @typedef {import("./ribbon-shared.js").ShellApi} ShellApi */
/** @typedef {import("./ribbon-shared.js").Control} Control */
/** @typedef {import("./ribbon-shared.js").Group} Group */
/** @typedef {import("./ribbon-shared.js").Tab} Tab */

/** @returns {Tab} */
function fileTab() {
  return {
    id: "file",
    label: "File",
    groups: [
      {
        id: "workspace",
        label: "Workspace",
        controls: [
          button({
            id: "rename-workspace",
            kind: "menu",
            label: "Rename",
            title: "Rename workspace",
            icon: "rename",
            keepFocus: true,
            attrs: { "data-action": "rename-workspace" },
            content: (ctx, close) =>
              textPopover(
                {
                  label: "Workspace name",
                  role: "workspace-name-input",
                  value: ctx.workspace.title,
                  onApply: (title) => ctx.shell.renameWorkspace(title)
                },
                close
              )
          }),
          button({
            id: "workspaces",
            kind: "menu",
            label: "Workspaces",
            title: "Switch to, create or delete a stored workspace",
            icon: "file",
            enabled: (ctx) => ctx.shell.hasWorkspaces(),
            disabledReason: "Workspaces are only kept where this page can store them",
            attrs: { "data-action": "workspaces" },
            content: (ctx, close) => workspaceSwitcher(ctx.shell, close)
          })
        ]
      },
      {
        id: "save",
        label: "Save",
        controls: [
          button({
            id: "save",
            label: "Mark saved",
            title: "Mark saved (Cmd/Ctrl+S)",
            icon: "save",
            attrs: { "data-action": "save" },
            action: (ctx) => ctx.shell.save()
          })
        ]
      },
      {
        id: "export",
        label: "Export",
        controls: [
          button({
            id: "export-json",
            label: "JSON",
            title: "Export workspace as JSON",
            icon: "export",
            attrs: { "data-action": "export-json" },
            action: (ctx) => ctx.shell.exportJSON()
          })
        ]
      },
      {
        id: "import",
        label: "Import",
        controls: [
          button({
            id: "import-json",
            label: "JSON",
            title: "Import a workspace from JSON",
            icon: "import",
            attrs: { "data-action": "import-json" },
            action: (ctx) => ctx.shell.pickImport()
          })
        ]
      }
    ]
  };
}

/**
 * @param {string | null | undefined} [pageType]
 * @returns {Tab}
 */
function viewTab(pageType) {
  const presentation = pageType === "presentation";
  /** @param {string} id @param {string} label @param {string} iconName @param {string} field @param {string} title */
  const viewToggle = (id, label, iconName, field, title) =>
    button({
      id,
      kind: "toggle",
      label,
      title,
      icon: iconName,
      attrs: { "data-action": id },
      enabled: hasPres,
      active: (ctx) => Boolean(/** @type {any} */ (ctx.presentationEditor?.getView())?.[field]),
      action: (ctx) => {
        const view = /** @type {any} */ (ctx.presentationEditor?.getView());
        ctx.presentationEditor?.setView({ [field]: !view?.[field] });
      }
    });
  return {
    id: "view",
    label: "View",
    groups: [
      ...(presentation
        ? [
            {
              id: "stage",
              label: "Stage",
              controls: [
                viewToggle("toggle-inspector", "Inspector", "inspector", "inspector", "Show or hide the inspector"),
                viewToggle("toggle-snap", "Guides", "snap", "snap", "Snap to guides"),
                viewToggle("toggle-grid", "Grid", "grid", "grid", "Show and snap to a grid")
              ]
            }
          ]
        : [{
        id: "zoom",
        label: "Zoom",
        controls: [
          /** @type {import("./ribbon-shared.js").Control} */ ({
            id: "zoom",
            kind: "select",
            label: "Zoom",
            icon: "zoom",
            size: "large",
            attrs: { "data-action": "zoom" },
            options: [75, 100, 125, 150].map((percent) => ({ value: String(percent), label: `${percent}%` })),
            value: (ctx) => String(ctx.shell.getZoom()),
            onSelect: (ctx, value) => ctx.shell.setZoom(Number(value))
          })
        ]
      }]),
      {
        id: "layout",
        label: "Layout",
        controls: [
          button({
            id: "toggle-sidebar",
            kind: "toggle",
            label: "Sidebar",
            title: "Show or hide the sidebar",
            icon: "sidebar",
            attrs: { "data-action": "toggle-sidebar" },
            active: (ctx) => !ctx.shell.isSidebarCollapsed(),
            action: (ctx) => ctx.shell.toggleSidebar()
          })
        ]
      }
    ]
  };
}

/**
 * The tabs for a page type: File, the type's own tabs, then View. With no page
 * open only File and View are offered.
 * @param {string | null | undefined} pageType
 * @returns {Tab[]}
 */
export function getTabs(pageType) {
  /** @type {Tab[]} */
  let own = [];
  if (pageType === "document") own = documentTabs();
  else if (pageType === "sheet") own = sheetTabs();
  else if (pageType === "presentation") own = presentationTabs();
  return [fileTab(), ...own, viewTab(pageType)];
}

/**
 * Tab to show first for a page type.
 * @param {string | null | undefined} pageType
 */
export function defaultTabId(pageType) {
  return pageType ? "home" : "file";
}
