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

import { h } from "./dom.js";
import { NO_LINK, buildLinkForm, linkPages } from "./link-form.js";
import { LAYOUTS } from "../presentation/layouts.js";
import { SIZE_PRESETS } from "../presentation/geometry.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */

/**
 * @typedef {object} RibbonContext
 * @property {Workspace} workspace
 * @property {import("../workspace/schema.js").PageEnvelope | undefined} page
 * @property {import("./block-editor.js").EditorHandle | null} docEditor
 * @property {import("./sheet-editor.js").SheetEditorHandle | null} sheetEditor
 * @property {import("./presentation-editor.js").PresentationEditorHandle | null} [presentationEditor]
 * @property {ShellApi} shell
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
 * @property {() => number} getZoom
 * @property {(percent: number) => void} setZoom
 * @property {() => boolean} isSidebarCollapsed
 * @property {() => void} toggleSidebar
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

const ANIMATION_SELECT_REASON = "Select an object to animate";
const ANIMATION_PICK_REASON = "Select an animation in the timeline";
export const THEME_REASON = "Themes arrive later";
export const EMBED_REASON = "References cannot be placed inside a sheet; use a formula in a cell";

// -- shared predicates --------------------------------------------------------

/** @param {RibbonContext} ctx */
const hasDoc = (ctx) => Boolean(ctx.docEditor);
/** @param {RibbonContext} ctx */
const hasSheet = (ctx) => Boolean(ctx.sheetEditor);
/** @param {RibbonContext} ctx */
const hasCell = (ctx) => Boolean(ctx.sheetEditor?.getSelection());
/** @param {RibbonContext} ctx */
const hasPres = (ctx) => Boolean(ctx.presentationEditor);
/** @param {RibbonContext} ctx */
const hasSlide = (ctx) => Boolean(ctx.presentationEditor?.getSlideId());
/** @param {RibbonContext} ctx */
const hasObjects = (ctx) => (ctx.presentationEditor?.getSelection().length ?? 0) > 0;
/** @param {RibbonContext} ctx */
const canEditPresText = (ctx) => Boolean(ctx.presentationEditor?.canEditText());

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
function textPopover(spec, close) {
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
function button(spec) {
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
function seam(spec, reason) {
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
function blockType(id, label, iconName, type, level, title) {
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
function markToggle(mark, label, iconName) {
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
function linkControl(id) {
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
function historyControls() {
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
function styleSelect() {
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
function headingMenu(item) {
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
        attrs: { "data-action": "insert-item", "data-insert": "heading", "data-level": level },
        action: () => ctx.docEditor?.insertAfterActive({ type: "heading", level })
      }))
  });
}

const INSERT_BLOCKS = [
  { key: "paragraph", label: "Paragraph", icon: "paragraph", block: { type: "paragraph" } },
  { key: "heading", label: "Heading", icon: "h1", block: { type: "heading", level: 1 } },
  { key: "list", label: "List", icon: "list", block: { type: "list" } },
  { key: "quote", label: "Quote", icon: "quote", block: { type: "quote" } },
  { key: "code", label: "Code", icon: "code-block", block: { type: "code" } },
  { key: "divider", label: "Divider", icon: "divider", block: { type: "divider" } }
];

// -- tabs ---------------------------------------------------------------------

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
          {
            id: "zoom",
            kind: "select",
            label: "Zoom",
            icon: "zoom",
            size: "large",
            attrs: { "data-action": "zoom" },
            options: [75, 100, 125, 150].map((percent) => ({ value: String(percent), label: `${percent}%` })),
            value: (ctx) => String(ctx.shell.getZoom()),
            onSelect: (ctx, value) => ctx.shell.setZoom(Number(value))
          }
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

/** @returns {Tab[]} */
function documentTabs() {
  return [
    {
      id: "home",
      label: "Home",
      groups: [
        {
          id: "styles",
          label: "Styles",
          controls: [
            styleSelect(),
            blockType("quote", "Quote", "quote", "quote"),
            blockType("code", "Code", "code-block", "code", undefined, "Code block")
          ]
        },
        {
          id: "font",
          label: "Font",
          controls: [
            markToggle("bold", "Bold", "bold"),
            markToggle("italic", "Italic", "italic"),
            markToggle("underline", "Underline", "underline"),
            markToggle("strike", "Strikethrough", "strike"),
            markToggle("code", "Inline code", "code")
          ]
        },
        {
          id: "paragraph",
          label: "Paragraph",
          controls: [
            blockType("list", "List", "list", "list"),
            button({
              id: "outdent",
              label: "Outdent",
              title: "Outdent (Shift+Tab)",
              icon: "outdent",
              attrs: { "data-action": "outdent" },
              enabled: (ctx) => Boolean(ctx.docEditor?.activeInfo?.().canOutdent),
              action: (ctx) => ctx.docEditor?.outdent()
            }),
            button({
              id: "indent",
              label: "Indent",
              title: "Indent (Tab)",
              icon: "indent",
              attrs: { "data-action": "indent" },
              enabled: (ctx) => Boolean(ctx.docEditor?.activeInfo?.().canIndent),
              action: (ctx) => ctx.docEditor?.indent()
            })
          ]
        },
        { id: "links", label: "Links", controls: [linkControl("link")] },
        { id: "history", label: "History", controls: historyControls() }
      ]
    },
    {
      id: "insert",
      label: "Insert",
      groups: [
        {
          id: "blocks",
          label: "Blocks",
          controls: INSERT_BLOCKS.map((item) =>
            item.key === "heading" ? headingMenu(item) : button({
              id: `insert-${item.key}`,
              label: item.label,
              icon: item.icon,
              attrs: { "data-action": "insert-item", "data-insert": item.key },
              enabled: hasDoc,
              action: (ctx) => ctx.docEditor?.insertAfterActive(item.block)
            })
          )
        },
        {
          id: "links",
          label: "Links",
          controls: [
            linkControl("insert-link")
          ]
        },
        {
          id: "references",
          label: "Reference",
          controls: [
            button({
              id: "reference-embed",
              label: "Embed",
              title: "Show part of another page here, live",
              icon: "link",
              attrs: { "data-action": "reference-embed" },
              enabled: hasDoc,
              action: (ctx, element) => ctx.docEditor?.insertEmbed(element)
            }),
            button({
              id: "reference-expression",
              label: "Expression",
              title: "Show the result of a formula over tables and sections",
              icon: "expression",
              attrs: { "data-action": "reference-expression" },
              enabled: hasDoc,
              action: (ctx, element) => ctx.docEditor?.insertExpression(element)
            })
          ]
        }
      ]
    }
  ];
}

/** @returns {Tab[]} */
function sheetTabs() {
  return [
    {
      id: "home",
      label: "Home",
      groups: [
        {
          id: "clipboard",
          label: "Clipboard",
          controls: [
            button({
              id: "paste",
              label: "Paste",
              title: "Paste the copied or cut cells (Ctrl/Cmd+V)",
              icon: "paste",
              attrs: { "data-action": "paste" },
              enabled: (ctx) => Boolean(ctx.sheetEditor?.canPaste()),
              action: (ctx) => ctx.sheetEditor?.paste()
            }),
            button({
              id: "cut",
              label: "Cut",
              size: "small",
              title: "Cut the selected cells; pasting moves them (Ctrl/Cmd+X)",
              icon: "cut",
              attrs: { "data-action": "cut" },
              enabled: hasCell,
              action: (ctx) => ctx.sheetEditor?.cut()
            }),
            button({
              id: "copy",
              label: "Copy",
              size: "small",
              title: "Copy the selected cells (Ctrl/Cmd+C)",
              icon: "copy",
              attrs: { "data-action": "copy" },
              enabled: hasCell,
              action: (ctx) => ctx.sheetEditor?.copy()
            })
          ]
        },
        {
          id: "cells",
          label: "Cells",
          controls: [
            button({
              id: "merge",
              label: "Merge",
              title: "Merge selected cells",
              icon: "merge",
              attrs: { "data-action": "merge" },
              enabled: (ctx) => Boolean(ctx.sheetEditor?.canMerge()),
              action: (ctx) => ctx.sheetEditor?.mergeSelection()
            }),
            button({
              id: "unmerge",
              label: "Unmerge",
              title: "Unmerge selected cells",
              icon: "unmerge",
              attrs: { "data-action": "unmerge" },
              enabled: (ctx) => Boolean(ctx.sheetEditor?.canUnmerge()),
              action: (ctx) => ctx.sheetEditor?.unmergeSelection()
            })
          ]
        },
        { id: "history", label: "History", controls: historyControls() }
      ]
    },
    {
      id: "insert",
      label: "Insert",
      groups: [
        {
          id: "tables",
          label: "Tables",
          controls: [
            button({
              id: "new-table",
              label: "New table",
              icon: "table-new",
              attrs: { "data-action": "add-table" },
              enabled: hasSheet,
              action: (ctx) => ctx.sheetEditor?.addTable()
            }),
            button({
              id: "rename-table",
              kind: "menu",
              label: "Rename table",
              icon: "table-rename",
              keepFocus: true,
              attrs: { "data-action": "rename-table" },
              enabled: hasCell,
              content: (ctx, close) =>
                textPopover(
                  {
                    label: "Table name",
                    role: "table-name-input",
                    value: ctx.sheetEditor?.selectedTableName() ?? "",
                    onApply: (name) => ctx.sheetEditor?.renameSelectedTable(name)
                  },
                  close
                )
            })
          ]
        },
        {
          id: "references",
          label: "Reference",
          controls: [seam({ id: "embed-reference", label: "Embed", icon: "link", attrs: { "data-action": "embed-reference" } }, EMBED_REASON)]
        }
      ]
    },
    {
      id: "layout",
      label: "Layout",
      groups: [
        {
          id: "size",
          label: "Size",
          controls: [
            {
              id: "row-height",
              kind: "field",
              label: "Row height",
              icon: "row-height",
              min: 1,
              attrs: { "data-action": "row-height" },
              enabled: hasCell,
              value: (ctx) => ctx.sheetEditor?.selectedRowHeight() ?? "",
              apply: (ctx, value) => ctx.sheetEditor?.setSelectedRowHeight(value)
            },
            {
              id: "column-width",
              kind: "field",
              label: "Column width",
              icon: "column-width",
              min: 1,
              attrs: { "data-action": "column-width" },
              enabled: hasCell,
              value: (ctx) => ctx.sheetEditor?.selectedColumnWidth() ?? "",
              apply: (ctx, value) => ctx.sheetEditor?.setSelectedColumnWidth(value)
            }
          ]
        }
      ]
    }
  ];
}

const SHAPE_ITEMS = [
  { shape: "rect", label: "Rectangle", icon: "rect" },
  { shape: "roundRect", label: "Rounded rectangle", icon: "roundrect" },
  { shape: "ellipse", label: "Ellipse", icon: "ellipse" },
  { shape: "triangle", label: "Triangle", icon: "triangle" },
  { shape: "arrow", label: "Arrow", icon: "arrow" }
];

const ARRANGE_ITEMS = [
  { op: "front", label: "Bring to front", icon: "bring-front" },
  { op: "forward", label: "Bring forward", icon: "bring-forward" },
  { op: "backward", label: "Send backward", icon: "send-backward" },
  { op: "back", label: "Send to back", icon: "send-back" }
];

const TRANSITION_STYLE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "wipe", label: "Wipe" }
];

const TRANSITION_DIRECTION_OPTIONS = [
  { value: "left", label: "From left" },
  { value: "right", label: "From right" },
  { value: "up", label: "From top" },
  { value: "down", label: "From bottom" }
];

/**
 * The link popover for presentations: the caret/selection while a text object is
 * being edited, otherwise the selected object. Mirrors the document popover.
 * @param {RibbonContext} ctx
 * @param {() => void} close
 * @returns {HTMLElement}
 */
function presentationLinkPopover(ctx, close) {
  return ctx.presentationEditor?.createLinkForm(close) ?? h("div", { class: "popover-body" });
}

/**
 * @param {string} mark
 * @param {string} label
 * @param {string} iconName
 * @returns {Control}
 */
function presentationMark(mark, label, iconName) {
  return {
    id: `pres-mark-${mark}`,
    kind: "toggle",
    size: "small",
    label,
    icon: iconName,
    attrs: { "data-action": "mark", "data-mark": mark },
    enabled: canEditPresText,
    active: (ctx) => Boolean(ctx.presentationEditor?.markActive(/** @type {any} */ (mark))),
    action: (ctx) => ctx.presentationEditor?.toggleMark(/** @type {any} */ (mark))
  };
}

/**
 * @param {string} align
 * @param {string} label
 * @returns {Control}
 */
function presentationAlign(align, label) {
  return {
    id: `pres-align-${align}`,
    kind: "toggle",
    size: "small",
    label,
    icon: `align-${align}`,
    attrs: { "data-action": "align", "data-align": align },
    enabled: canEditPresText,
    active: (ctx) => ctx.presentationEditor?.getTextState()?.align === align,
    action: (ctx) => ctx.presentationEditor?.setAlign(/** @type {any} */ (align))
  };
}

/** @returns {Control} */
function arrangeMenu() {
  return button({
    id: "arrange",
    kind: "menu",
    label: "Arrange",
    title: "Arrange objects",
    icon: "bring-front",
    attrs: { "data-action": "arrange-menu" },
    enabled: hasObjects,
    items: (ctx) =>
      ARRANGE_ITEMS.map((item) => ({
        label: item.label,
        icon: item.icon,
        attrs: { "data-action": `arrange-${item.op}` },
        action: () => ctx.presentationEditor?.arrange(/** @type {any} */ (item.op))
      }))
  });
}

/** @returns {Control} */
function layoutMenu() {
  return button({
    id: "new-slide",
    kind: "menu",
    label: "New slide",
    icon: "slide-new",
    attrs: { "data-action": "new-slide" },
    enabled: hasPres,
    items: (ctx) =>
      LAYOUTS.map((layout) => ({
        label: layout.label,
        icon: "layout",
        attrs: { "data-action": "new-slide-layout", "data-layout": layout.id },
        action: () => ctx.presentationEditor?.newSlide(layout.id)
      }))
  });
}

/**
 * A Width / Height field that routes through the editor's scale-or-keep popover.
 * @param {"width" | "height"} axis
 * @returns {Control}
 */
function slideSizeField(axis) {
  return {
    id: `slide-${axis}`,
    kind: "field",
    label: axis === "width" ? "Width" : "Height",
    icon: axis === "width" ? "column-width" : "row-height",
    min: 320,
    attrs: { "data-action": `slide-${axis}` },
    enabled: hasPres,
    value: (ctx) => ctx.presentationEditor?.getSize()[axis] ?? "",
    apply: (ctx, value) => {
      const size = ctx.presentationEditor?.getSize();
      if (!size) return;
      ctx.presentationEditor?.requestSlideSize(
        axis === "width" ? value : size.width,
        axis === "height" ? value : size.height
      );
    }
  };
}

const ANIMATION_TRIGGER_OPTIONS = [
  { value: "click", label: "On click" },
  { value: "with", label: "With previous" },
  { value: "after", label: "After previous" }
];

/** @param {RibbonContext} ctx */
const hasAnimation = (ctx) => Boolean(ctx.presentationEditor?.getSelectedAnimation());

/**
 * Position of the selected animation in the slide's order, or -1.
 * @param {RibbonContext} ctx
 * @returns {number}
 */
function animationIndex(ctx) {
  const editor = ctx.presentationEditor;
  const selected = editor?.getSelectedAnimation();
  return selected && editor ? editor.getAnimations().findIndex((animation) => animation.id === selected.id) : -1;
}

/** @param {RibbonContext} ctx */
const canApplyEffect = (ctx) => hasObjects(ctx) || hasAnimation(ctx);

/**
 * A gallery button: it sets the effect of the selected animation, or, when none is selected
 * (or it belongs to another object), animates the selected objects with it.
 * @param {"appear" | "fade-in" | "motion"} effect
 * @param {string} label
 * @param {string} title
 * @param {string} iconName
 * @returns {Control}
 */
function animationEffectButton(effect, label, title, iconName) {
  return button({
    id: `animation-${effect}`,
    label,
    title,
    icon: iconName,
    attrs: { "data-action": `animation-${effect}` },
    enabled: canApplyEffect,
    disabledReason: ANIMATION_SELECT_REASON,
    active: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === effect,
    action: (ctx) => ctx.presentationEditor?.applyAnimationEffect(effect)
  });
}

/**
 * Number field for how far the selected motion animation travels along one axis (px). The
 * start point stays where it is; the end point moves.
 * @param {"x" | "y"} axis
 * @returns {Control}
 */
function animationDistanceField(axis) {
  return {
    id: `animation-move-${axis}`,
    kind: "field",
    label: `Move ${axis.toUpperCase()} (px)`,
    icon: "motion-path",
    attrs: { "data-action": `animation-move-${axis}` },
    enabled: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === "motion",
    disabledReason: "Distance applies to Motion path animations",
    value: (ctx) => {
      const path = ctx.presentationEditor?.getSelectedAnimation()?.path;
      return path ? Math.round(path.to[axis] - path.from[axis]) : "";
    },
    apply: (ctx, value) => {
      const path = ctx.presentationEditor?.getSelectedAnimation()?.path;
      if (!path) return;
      ctx.presentationEditor?.updateAnimation({ path: { from: path.from, to: { ...path.to, [axis]: path.from[axis] + value } } });
    }
  };
}

/**
 * Number field for the selected animation's delay or duration (milliseconds).
 * @param {"delay" | "duration"} key
 * @param {string} label
 * @param {number} min
 * @returns {Control}
 */
function animationTimeField(key, label, min) {
  return {
    id: `animation-${key}`,
    kind: "field",
    label,
    icon: "transition",
    min,
    attrs: { "data-action": `animation-${key}` },
    enabled: hasAnimation,
    disabledReason: ANIMATION_PICK_REASON,
    value: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.[key] ?? "",
    apply: (ctx, value) => ctx.presentationEditor?.updateAnimation({ [key]: value })
  };
}

/** @returns {Tab[]} */
function presentationTabs() {
  return [
    {
      id: "home",
      label: "Home",
      groups: [
        {
          id: "clipboard",
          label: "Clipboard",
          controls: [
            button({
              id: "paste",
              label: "Paste",
              title: "Paste the copied objects (Ctrl/Cmd+V)",
              icon: "paste",
              attrs: { "data-action": "paste" },
              enabled: (ctx) => hasSlide(ctx) && Boolean(ctx.presentationEditor?.canPaste()),
              action: (ctx) => ctx.presentationEditor?.paste()
            }),
            button({
              id: "cut",
              label: "Cut",
              size: "small",
              title: "Cut (Ctrl/Cmd+X)",
              icon: "cut",
              attrs: { "data-action": "cut" },
              enabled: hasObjects,
              action: (ctx) => ctx.presentationEditor?.cut()
            }),
            button({
              id: "copy",
              label: "Copy",
              size: "small",
              title: "Copy (Ctrl/Cmd+C)",
              icon: "copy",
              attrs: { "data-action": "copy" },
              enabled: hasObjects,
              action: (ctx) => ctx.presentationEditor?.copy()
            })
          ]
        },
        {
          id: "slides",
          label: "Slides",
          controls: [
            layoutMenu(),
            button({
              id: "duplicate-slide",
              label: "Duplicate",
              size: "small",
              title: "Duplicate slide",
              icon: "duplicate",
              attrs: { "data-action": "duplicate-slide" },
              enabled: hasSlide,
              action: (ctx) => {
                const id = ctx.presentationEditor?.getSlideId();
                if (id) ctx.presentationEditor?.duplicateSlide(id);
              }
            }),
            button({
              id: "delete-slide",
              label: "Delete",
              size: "small",
              title: "Delete slide",
              icon: "trash",
              attrs: { "data-action": "delete-slide" },
              enabled: (ctx) => hasSlide(ctx) && Boolean(ctx.presentationEditor?.canDeleteSlide()),
              action: (ctx) => {
                const id = ctx.presentationEditor?.getSlideId();
                if (id) ctx.presentationEditor?.deleteSlide(id);
              }
            })
          ]
        },
        {
          id: "text",
          label: "Text",
          controls: [
            presentationMark("bold", "Bold", "bold"),
            presentationMark("italic", "Italic", "italic"),
            presentationMark("underline", "Underline", "underline"),
            presentationMark("strike", "Strikethrough", "strike"),
            presentationAlign("left", "Align left"),
            presentationAlign("center", "Align centre"),
            presentationAlign("right", "Align right"),
            button({
              id: "pres-link",
              kind: "menu",
              label: "Link",
              title: "Link",
              icon: "link",
              keepFocus: true,
              attrs: { "data-action": "link" },
              enabled: hasObjects,
              content: presentationLinkPopover
            })
          ]
        },
        { id: "arrange", label: "Arrange", controls: [arrangeMenu()] },
        { id: "history", label: "History", controls: historyControls() }
      ]
    },
    {
      id: "insert",
      label: "Insert",
      groups: [
        {
          id: "objects",
          label: "Objects",
          controls: [
            button({
              id: "insert-textbox",
              kind: "toggle",
              label: "Text box",
              title: "Text box: drag on the slide to draw it",
              icon: "textbox",
              attrs: { "data-action": "insert-textbox" },
              enabled: hasSlide,
              active: (ctx) => ctx.presentationEditor?.getTool()?.type === "text",
              action: (ctx) => {
                const armed = ctx.presentationEditor?.getTool()?.type === "text";
                ctx.presentationEditor?.setTool(armed ? null : { type: "text" });
              }
            }),
            button({
              id: "insert-shape",
              kind: "menu",
              label: "Shape",
              title: "Shape: pick one, then drag on the slide",
              icon: "shape",
              attrs: { "data-action": "insert-shape" },
              enabled: hasSlide,
              active: (ctx) => ctx.presentationEditor?.getTool()?.type === "shape",
              items: (ctx) =>
                SHAPE_ITEMS.map((item) => ({
                  label: item.label,
                  icon: item.icon,
                  attrs: { "data-action": "insert-shape-item", "data-shape": item.shape },
                  action: () => ctx.presentationEditor?.setTool({ type: "shape", shape: item.shape })
                }))
            }),
            button({
              id: "insert-line",
              kind: "toggle",
              label: "Line",
              title: "Line: drag on the slide to draw it",
              icon: "line",
              attrs: { "data-action": "insert-line" },
              enabled: hasSlide,
              active: (ctx) => ctx.presentationEditor?.getTool()?.type === "line",
              action: (ctx) => {
                const armed = ctx.presentationEditor?.getTool()?.type === "line";
                ctx.presentationEditor?.setTool(armed ? null : { type: "line" });
              }
            }),
            button({
              id: "insert-image",
              label: "Image",
              title: "Insert an image from a file",
              icon: "image",
              attrs: { "data-action": "insert-image" },
              enabled: hasSlide,
              action: (ctx) => ctx.presentationEditor?.pickImage()
            })
          ]
        },
        {
          id: "references",
          label: "Reference",
          controls: [
            button({
              id: "reference-embed",
              label: "Embed",
              title: "Show part of another page on this slide, live",
              icon: "link",
              attrs: { "data-action": "reference-embed" },
              enabled: hasSlide,
              action: (ctx, element) => ctx.presentationEditor?.insertEmbed(element)
            }),
            button({
              id: "reference-expression",
              label: "Expression",
              title: "Show the result of a formula over tables and sections",
              icon: "expression",
              attrs: { "data-action": "reference-expression" },
              enabled: hasSlide,
              action: (ctx, element) => ctx.presentationEditor?.insertExpression(element)
            })
          ]
        }
      ]
    },
    {
      id: "design",
      label: "Design",
      groups: [
        {
          id: "size",
          label: "Slide size",
          controls: [
            button({
              id: "slide-size",
              kind: "menu",
              label: "Size",
              title: "Slide size presets",
              icon: "layout",
              attrs: { "data-action": "slide-size" },
              enabled: hasPres,
              items: (ctx) =>
                SIZE_PRESETS.map((preset) => ({
                  label: `${preset.label}  ${preset.width}×${preset.height}`,
                  attrs: { "data-action": "slide-size-preset", "data-preset": preset.id },
                  action: () => ctx.presentationEditor?.requestSlideSize(preset.width, preset.height)
                }))
            }),
            slideSizeField("width"),
            slideSizeField("height")
          ]
        },
        {
          id: "background",
          label: "Background",
          controls: [
            {
              id: "slide-background",
              kind: "color",
              label: "Background",
              title: "Slide background colour",
              icon: "background",
              attrs: { "data-action": "slide-background" },
              enabled: hasSlide,
              value: (ctx) => ctx.presentationEditor?.getSlide()?.background.color ?? "#ffffff",
              onSelect: (ctx, value) => ctx.presentationEditor?.setBackground(value)
            }
          ]
        },
        {
          id: "theme",
          label: "Theme",
          controls: [seam({ id: "theme", label: "Theme", icon: "theme", attrs: { "data-action": "theme" } }, THEME_REASON)]
        }
      ]
    },
    {
      id: "transitions",
      label: "Transitions",
      groups: [
        {
          id: "transition",
          label: "Transition",
          controls: [
            {
              id: "transition-style",
              kind: "select",
              label: "Style",
              icon: "transition",
              size: "large",
              attrs: { "data-action": "transition-style" },
              options: TRANSITION_STYLE_OPTIONS,
              enabled: hasSlide,
              value: (ctx) => ctx.presentationEditor?.getSlide()?.transition.style ?? "none",
              onSelect: (ctx, value) => ctx.presentationEditor?.setTransition({ style: value })
            },
            {
              id: "transition-direction",
              kind: "select",
              label: "Direction",
              icon: "transition",
              size: "large",
              attrs: { "data-action": "transition-direction" },
              options: TRANSITION_DIRECTION_OPTIONS,
              enabled: (ctx) => (ctx.presentationEditor?.getSlide()?.transition.style ?? "none") === "wipe",
              value: (ctx) => ctx.presentationEditor?.getSlide()?.transition.direction ?? "left",
              onSelect: (ctx, value) => ctx.presentationEditor?.setTransition({ direction: value })
            },
            {
              id: "transition-duration",
              kind: "field",
              label: "Duration (ms)",
              icon: "transition",
              min: 0,
              attrs: { "data-action": "transition-duration" },
              enabled: (ctx) => (ctx.presentationEditor?.getSlide()?.transition.style ?? "none") !== "none",
              value: (ctx) => ctx.presentationEditor?.getSlide()?.transition.duration ?? "",
              apply: (ctx, value) => ctx.presentationEditor?.setTransition({ duration: value })
            },
            button({
              id: "transition-all",
              label: "Apply to all",
              title: "Use this slide's transition on every slide",
              icon: "slide",
              attrs: { "data-action": "apply-transition-all" },
              enabled: hasSlide,
              action: (ctx) => ctx.presentationEditor?.applyTransitionToAll()
            })
          ]
        }
      ]
    },
    {
      id: "animations",
      label: "Animations",
      groups: [
        {
          id: "animation",
          label: "Animation",
          controls: [
            animationEffectButton("appear", "Appear", "Appear: the object shows up when it starts", "animation"),
            animationEffectButton("fade-in", "Fade in", "Fade the object in", "transition"),
            button({
              id: "animation-slide-in",
              kind: "menu",
              label: "Slide in",
              title: "Slide the object in from an edge",
              icon: "slide",
              attrs: { "data-action": "animation-slide-in" },
              enabled: canApplyEffect,
              disabledReason: ANIMATION_SELECT_REASON,
              active: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === "slide-in",
              items: (ctx) =>
                TRANSITION_DIRECTION_OPTIONS.map((option) => ({
                  label: option.label,
                  attrs: { "data-action": "animation-slide-in-item", "data-direction": option.value },
                  action: () => ctx.presentationEditor?.applyAnimationEffect("slide-in", { direction: /** @type {any} */ (option.value) })
                }))
            }),
            animationEffectButton("motion", "Motion path", "Move the object from one point to another", "motion-path"),
            button({
              id: "animation-add",
              kind: "menu",
              label: "Add animation",
              title: "Give the selected objects another animation, keeping the ones they have",
              icon: "plus",
              attrs: { "data-action": "animation-add" },
              enabled: hasObjects,
              disabledReason: ANIMATION_SELECT_REASON,
              items: (ctx) => [
                { label: "Appear", icon: "animation", attrs: { "data-action": "animation-add-item", "data-effect": "appear" }, action: () => ctx.presentationEditor?.addAnimation("appear") },
                { label: "Fade in", icon: "transition", attrs: { "data-action": "animation-add-item", "data-effect": "fade-in" }, action: () => ctx.presentationEditor?.addAnimation("fade-in") },
                ...TRANSITION_DIRECTION_OPTIONS.map((option) => ({
                  label: `Slide in ${option.label.toLowerCase()}`,
                  icon: "slide",
                  attrs: { "data-action": "animation-add-item", "data-effect": "slide-in", "data-direction": option.value },
                  action: () => ctx.presentationEditor?.addAnimation("slide-in", { direction: /** @type {any} */ (option.value) })
                })),
                { label: "Motion path", icon: "motion-path", attrs: { "data-action": "animation-add-item", "data-effect": "motion" }, action: () => ctx.presentationEditor?.addAnimation("motion") }
              ]
            })
          ]
        },
        {
          id: "animation-timing",
          label: "Timing",
          controls: [
            {
              id: "animation-trigger",
              kind: "select",
              label: "Start",
              icon: "on-click",
              size: "large",
              attrs: { "data-action": "animation-trigger" },
              options: ANIMATION_TRIGGER_OPTIONS,
              enabled: hasAnimation,
              disabledReason: ANIMATION_PICK_REASON,
              value: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.trigger ?? "click",
              onSelect: (ctx, value) => ctx.presentationEditor?.updateAnimation({ trigger: value })
            },
            animationTimeField("delay", "Delay (ms)", 0),
            animationTimeField("duration", "Duration (ms)", 0),
            {
              id: "animation-direction",
              kind: "select",
              label: "Direction",
              icon: "transition",
              size: "large",
              attrs: { "data-action": "animation-direction" },
              options: TRANSITION_DIRECTION_OPTIONS,
              enabled: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === "slide-in",
              disabledReason: "Direction applies to Slide in animations",
              value: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.direction ?? "left",
              onSelect: (ctx, value) => ctx.presentationEditor?.updateAnimation({ direction: value })
            },
            animationDistanceField("x"),
            animationDistanceField("y")
          ]
        },
        {
          id: "animation-order",
          label: "Order",
          controls: [
            button({
              id: "animation-pick",
              kind: "menu",
              label: "Animations",
              title: "Choose which animation on this slide to edit",
              icon: "list",
              attrs: { "data-action": "animation-pick" },
              enabled: (ctx) => (ctx.presentationEditor?.getAnimations().length ?? 0) > 0,
              disabledReason: "This slide has no animations",
              items: (ctx) =>
                (ctx.presentationEditor?.describeAnimations() ?? []).map((entry) => ({
                  label: `${entry.number}. ${entry.label}`,
                  icon: entry.selected ? "check" : undefined,
                  className: entry.selected ? "is-current" : undefined,
                  attrs: { "data-action": "animation-pick-item", "data-animation-id": entry.id },
                  action: () => ctx.presentationEditor?.selectAnimation(entry.id)
                }))
            }),
            button({
              id: "animation-earlier",
              size: "small",
              label: "Move earlier",
              icon: "move-up",
              attrs: { "data-action": "animation-earlier" },
              enabled: (ctx) => animationIndex(ctx) > 0,
              disabledReason: ANIMATION_PICK_REASON,
              action: (ctx) => ctx.presentationEditor?.moveSelectedAnimation(-1)
            }),
            button({
              id: "animation-later",
              size: "small",
              label: "Move later",
              icon: "move-down",
              attrs: { "data-action": "animation-later" },
              enabled: (ctx) => {
                const index = animationIndex(ctx);
                return index >= 0 && index < (ctx.presentationEditor?.getAnimations().length ?? 0) - 1;
              },
              disabledReason: ANIMATION_PICK_REASON,
              action: (ctx) => ctx.presentationEditor?.moveSelectedAnimation(1)
            }),
            button({
              id: "animation-remove",
              size: "small",
              label: "Remove animation",
              icon: "trash",
              attrs: { "data-action": "animation-remove" },
              enabled: hasAnimation,
              disabledReason: ANIMATION_PICK_REASON,
              action: (ctx) => ctx.presentationEditor?.removeAnimation()
            })
          ]
        },
        {
          id: "animation-preview",
          label: "Preview",
          controls: [
            button({
              id: "animation-preview",
              kind: "toggle",
              label: "Preview",
              title: "Play this slide's animations",
              icon: "play",
              attrs: { "data-action": "animation-preview" },
              enabled: (ctx) => Boolean(ctx.presentationEditor?.isPreviewing() || ctx.presentationEditor?.getAnimations().length),
              disabledReason: "This slide has no animations",
              active: (ctx) => Boolean(ctx.presentationEditor?.isPreviewing()),
              action: (ctx) => {
                const editor = ctx.presentationEditor;
                if (editor?.isPreviewing()) editor.stopPreview();
                else editor?.startPreview();
              }
            })
          ]
        }
      ]
    }
  ];
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
