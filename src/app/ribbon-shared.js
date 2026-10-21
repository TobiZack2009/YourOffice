/**
 * Pieces shared by every ribbon tab: the context and control types, enable predicates, popover bodies and control factories.
 */

import { h } from "./dom.js";
import { NO_LINK, buildLinkForm, linkPages } from "./link-form.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */

/**
 * @typedef {object} RibbonContext
 * @property {Workspace} workspace
 * @property {import("../workspace/selectors.js").PageInfo | undefined} page
 * @property {import("./block-editor.js").EditorHandle | null} docEditor
 * @property {import("./sheet-editor.js").SheetEditorHandle | null} sheetEditor
 * @property {import("./presentation-editor.js").PresentationEditorHandle | null} [presentationEditor]
 * @property {ShellApi} shell
 */

/**
 * @typedef {object} WorkspaceEntry A stored workspace, as the switcher lists it.
 * @property {string} id
 * @property {string} title
 * @property {number} savedAt
 * @property {boolean} active
 * @property {boolean} recovery
 */

/**
 * The slice of the shell the ribbon is allowed to call.
 * @typedef {object} ShellApi
 * @property {() => void} undo
 * @property {() => void} redo
 * @property {() => void} save
 * @property {() => void} exportJSON
 * @property {() => void} pickImport
 * @property {(title: string) => void} renameWorkspace
 * @property {() => boolean} hasWorkspaces Whether stored workspaces can be listed and switched.
 * @property {() => Promise<WorkspaceEntry[]>} listWorkspaces
 * @property {(id: string) => void} openWorkspace
 * @property {(title: string) => void} createWorkspace
 * @property {(entry: WorkspaceEntry) => Promise<boolean>} deleteWorkspace Asks first; true when it was deleted.
 * @property {() => number} getZoom
 * @property {(percent: number) => void} setZoom
 * @property {() => boolean} isSidebarCollapsed
 * @property {() => void} toggleSidebar
 * @property {(from: "beginning" | "current") => boolean} startSlideshow
 * @property {() => boolean} isSlideshowActive
 */

/**
 * @typedef {object} Control
 * @property {string} id
 * @property {"button" | "toggle" | "select" | "menu" | "field" | "color"} kind
 * @property {string} label
 * @property {string} [title]
 * @property {string} [icon]
 * @property {"large" | "small"} [size]
 * @property {Record<string, string | number>} [attrs]
 * @property {(ctx: RibbonContext, element: HTMLElement) => void} [action]
 * @property {(ctx: RibbonContext) => boolean} [enabled]
 * @property {(ctx: RibbonContext) => boolean} [active]
 * @property {string} [disabledReason]
 * @property {{ value: string, label: string }[]} [options]
 * @property {(ctx: RibbonContext) => string | number} [value]
 * @property {(ctx: RibbonContext, value: any) => void} [onSelect]
 * @property {(ctx: RibbonContext) => import("./popover.js").MenuItem[]} [items]
 * @property {(ctx: RibbonContext, close: () => void) => HTMLElement} [content]
 * @property {boolean} [keepFocus]
 * @property {number} [min]
 * @property {(ctx: RibbonContext, value: number) => void} [apply]
 */

/**
 * @typedef {{ id: string, label: string, controls: Control[] }} Group
 * @typedef {{ id: string, label: string, groups: Group[] }} Tab
 */

export const ANIMATION_SELECT_REASON = "Select an object to animate";
export const ANIMATION_PICK_REASON = "Select an animation in the timeline";
export const THEME_REASON = "Themes arrive later";
export const EMBED_REASON = "References cannot be placed inside a sheet; use a formula in a cell";

// -- shared predicates --------------------------------------------------------

/** @param {RibbonContext} ctx */
export const hasDoc = (ctx) => Boolean(ctx.docEditor);
/** @param {RibbonContext} ctx */
export const hasSheet = (ctx) => Boolean(ctx.sheetEditor);
/** @param {RibbonContext} ctx */
export const hasCell = (ctx) => Boolean(ctx.sheetEditor?.getSelection());
/** @param {RibbonContext} ctx */
export const hasPres = (ctx) => Boolean(ctx.presentationEditor);
/** @param {RibbonContext} ctx */
export const hasSlide = (ctx) => Boolean(ctx.presentationEditor?.getSlideId());
/** @param {RibbonContext} ctx */
export const hasObjects = (ctx) => (ctx.presentationEditor?.getSelection().length ?? 0) > 0;
/** @param {RibbonContext} ctx */
export const canEditPresText = (ctx) => Boolean(ctx.presentationEditor?.canEditText());

// -- popover bodies -----------------------------------------------------------

/** @returns {Range | null} */
function currentRange() {
  const selection = document.getSelection();
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
}

/** @param {Range | null} range */
function restoreRange(range) {
  if (!range) return;
  const selection = document.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A one-field popover: input + Apply (Enter applies, Escape closes).
 * @param {{ label: string, role: string, value: string, placeholder?: string, onApply: (value: string) => void }} spec
 * @param {() => void} close
 * @returns {HTMLElement}
 */
export function textPopover(spec, close) {
  const input = h("input", {
    class: "popover-input",
    type: "text",
    value: spec.value,
    placeholder: spec.placeholder ?? "",
    "aria-label": spec.label,
    "data-role": spec.role
  });
  const apply = h("button", { class: "popover-apply", type: "button", text: "Apply" });
  apply.addEventListener("click", () => {
    const value = /** @type {HTMLInputElement} */ (input).value.trim();
    close();
    if (value) spec.onApply(value);
  });
  input.addEventListener("keydown", (event) => {
    const key = /** @type {KeyboardEvent} */ (event).key;
    if (key === "Enter") {
      event.preventDefault();
      apply.click();
    } else if (key === "Escape") {
      close();
    }
  });
  return h("div", { class: "popover-body" }, [input, h("div", { class: "popover-row" }, [apply])]);
}

/**
 * The link popover. The editor selection is captured when it opens (ribbon
 * buttons never take focus), then restored before the link is applied.
 * @param {RibbonContext} ctx
 * @param {() => void} close
 * @returns {HTMLElement}
 */
function linkPopover(ctx, close) {
  const savedRange = currentRange();
  const info = ctx.docEditor?.getLinkInfo?.() ?? NO_LINK;
  return buildLinkForm({
    info,
    pages: linkPages(ctx.workspace),
    onApply: ({ url, text }) => {
      restoreRange(savedRange);
      ctx.docEditor?.setLink(url, text);
    },
    onRemove: () => {
      restoreRange(savedRange);
      ctx.docEditor?.setLink("");
    },
    close
  });
}

// -- control factories --------------------------------------------------------

/**
 * @param {Partial<Control> & { id: string, label: string }} spec
 * @returns {Control}
 */
export function button(spec) {
  return { kind: "button", size: "large", ...spec };
}

/** @type {Control["attrs"]} */
const NONE = {};

/**
 * A disabled seam: present in the ribbon so the structure is visible, but inert.
 * @param {Partial<Control> & { id: string, label: string, icon: string }} spec
 * @param {string} reason
 * @returns {Control}
 */
export function seam(spec, reason) {
  return { kind: "button", size: "large", attrs: NONE, enabled: () => false, disabledReason: reason, ...spec };
}

/**
 * @param {string} id
 * @param {string} label
 * @param {string} iconName
 * @param {string} type
 * @param {number} [level]
 * @param {string} [title]
 * @returns {Control}
 */
export function blockType(id, label, iconName, type, level, title) {
  return button({
    id,
    label,
    title: title ?? label,
    icon: iconName,
    kind: "toggle",
    attrs: { "data-action": "block-type", "data-type": type, "data-level": level ?? "" },
    enabled: hasDoc,
    active: (ctx) => {
      const info = ctx.docEditor?.activeInfo?.();
      return Boolean(info && info.type === type && (level === undefined || info.level === level));
    },
    action: (ctx) => ctx.docEditor?.setActiveType({ type, level })
  });
}

/**
 * @param {string} mark
 * @param {string} label
 * @param {string} iconName
 * @returns {Control}
 */
export function markToggle(mark, label, iconName) {
  return {
    id: `mark-${mark}`,
    kind: "button",
    size: "small",
    label,
    icon: iconName,
    attrs: { "data-action": "mark", "data-mark": mark },
    enabled: hasDoc,
    action: (ctx) => ctx.docEditor?.toggleMark(/** @type {any} */ (mark))
  };
}

/** @param {string} id */
export function linkControl(id) {
  return button({
    id,
    kind: "menu",
    label: "Link",
    title: "Link",
    icon: "link",
    keepFocus: true,
    attrs: { "data-action": "link" },
    enabled: hasDoc,
    active: (ctx) => Boolean(ctx.docEditor?.getLinkInfo?.().inLink),
    content: linkPopover
  });
}

/** @returns {Control[]} */
export function historyControls() {
  return [
    button({
      id: "undo",
      label: "Undo",
      icon: "undo",
      attrs: { "data-action": "ribbon-undo" },
      enabled: (ctx) => ctx.workspace.canUndo,
      action: (ctx) => ctx.shell.undo()
    }),
    button({
      id: "redo",
      label: "Redo",
      icon: "redo",
      attrs: { "data-action": "ribbon-redo" },
      enabled: (ctx) => ctx.workspace.canRedo,
      action: (ctx) => ctx.shell.redo()
    })
  ];
}

const STYLE_OPTIONS = [
  { value: "", label: "Style" },
  { value: "paragraph", label: "Paragraph" },
  { value: "heading-1", label: "Heading 1" },
  { value: "heading-2", label: "Heading 2" },
  { value: "heading-3", label: "Heading 3" }
];

/** @returns {Control} Paragraph / Heading 1-3 chooser for the active block (or selected blocks). */
export function styleSelect() {
  return {
    id: "style",
    kind: "select",
    label: "Style",
    title: "Paragraph or heading style",
    icon: "paragraph",
    size: "large",
    attrs: { "data-action": "block-style" },
    options: STYLE_OPTIONS,
    enabled: hasDoc,
    value: (ctx) => {
      const info = ctx.docEditor?.activeInfo?.();
      if (info?.type === "paragraph") return "paragraph";
      if (info?.type === "heading" && info.level) return `heading-${info.level}`;
      return "";
    },
    onSelect: (ctx, value) => {
      if (value === "paragraph") ctx.docEditor?.setActiveType({ type: "paragraph" });
      else if (value.startsWith("heading-")) {
        ctx.docEditor?.setActiveType({ type: "heading", level: Number(value.slice(8)) });
      }
    }
  };
}

/**
 * @param {{ key: string, label: string, icon: string }} item
 * @returns {Control}
 */
export function headingMenu(item) {
  return button({
    id: `insert-${item.key}`,
    kind: "menu",
    label: item.label,
    icon: item.icon,
    attrs: { "data-action": "insert-heading-menu" },
    enabled: hasDoc,
    items: (ctx) =>
      [1, 2, 3].map((level) => ({
        label: `Heading ${level}`,
        icon: `h${level}`,
        attrs: { "data-action": "insert-item", "data-insert": "heading", "data-level": String(level) },
        action: () => ctx.docEditor?.insertAfterActive({ type: "heading", level })
      }))
  });
}

export const INSERT_BLOCKS = [
  { key: "paragraph", label: "Paragraph", icon: "paragraph", block: { type: "paragraph" } },
  { key: "heading", label: "Heading", icon: "h1", block: { type: "heading", level: 1 } },
  { key: "list", label: "List", icon: "list", block: { type: "list" } },
  { key: "quote", label: "Quote", icon: "quote", block: { type: "quote" } },
  { key: "code", label: "Code", icon: "code-block", block: { type: "code" } },
  { key: "divider", label: "Divider", icon: "divider", block: { type: "divider" } }
];
