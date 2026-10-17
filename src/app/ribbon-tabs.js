/**
 * Ribbon structure: which tabs, groups and controls each page type shows.
 *
 * This module is data. `getTabs(pageType)` returns the tab list; `ribbon.js`
 * renders it and re-evaluates `enabled` / `active` against a context. Adding a
 * tab or a control is a data change here, not a change to the renderer.
 *
 * A control is
 *   { id, kind: "button" | "toggle" | "select" | "menu" | "field", label, icon,
 *     size: "large" | "small", title?, attrs?, action(ctx, element), enabled(ctx),
 *     active(ctx), disabledReason? }
 * - toggle: a button that can show an active state.
 * - select: `options`, `value(ctx)`, `action(ctx, value)`.
 * - menu: opens a popover from `items(ctx)` (menu rows) or `content(ctx, close)`.
 * - field: a number input with Apply — `value(ctx)`, `apply(ctx, number)`.
 * `attrs` are extra attributes on the rendered element; the stable `data-action`
 * / `data-type` / `data-level` / `data-mark` / `data-insert` hooks live there.
 *
 * ctx is { workspace, page, docEditor, sheetEditor, shell }.
 */

import { h } from "./dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */

/**
 * @typedef {object} RibbonContext
 * @property {Workspace} workspace
 * @property {import("../workspace/schema.js").PageEnvelope | undefined} page
 * @property {import("./block-editor.js").EditorHandle | null} docEditor
 * @property {import("./sheet-editor.js").SheetEditorHandle | null} sheetEditor
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
 * @property {"button" | "toggle" | "select" | "menu" | "field"} kind
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

export const PRESENTATION_REASON = "Presentations arrive in Phase 5";
export const EMBED_REASON = "Embeds arrive with references (Phase 6)";

// -- shared predicates --------------------------------------------------------

/** @param {RibbonContext} ctx */
const hasDoc = (ctx) => Boolean(ctx.docEditor);
/** @param {RibbonContext} ctx */
const hasSheet = (ctx) => Boolean(ctx.sheetEditor);
/** @param {RibbonContext} ctx */
const hasCell = (ctx) => Boolean(ctx.sheetEditor?.getSelection());

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
  const input = h("input", {
    class: "popover-input",
    type: "url",
    placeholder: "https://…",
    "aria-label": "Link URL",
    "data-role": "link-input"
  });
  const apply = h("button", { class: "popover-apply", type: "button", text: "Apply" });
  const remove = h("button", { class: "popover-remove", type: "button", text: "Remove" });

  apply.addEventListener("click", () => {
    const value = /** @type {HTMLInputElement} */ (input).value.trim();
    if (value) {
      restoreRange(savedRange);
      ctx.docEditor?.setLink(value);
    }
    close();
  });
  remove.addEventListener("click", () => {
    restoreRange(savedRange);
    ctx.docEditor?.setLink("");
    close();
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
  return h("div", { class: "popover-body" }, [input, h("div", { class: "popover-row" }, [apply, remove])]);
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

/** @returns {Control[]} Row and column structure controls (kept `data-action`s). */
function lineControls() {
  return [
    button({
      id: "insert-row",
      label: "Insert row",
      icon: "row-add",
      attrs: { "data-action": "add-row" },
      enabled: hasCell,
      action: (ctx) => ctx.sheetEditor?.insertRow()
    }),
    button({
      id: "delete-row",
      label: "Delete row",
      icon: "row-delete",
      attrs: { "data-action": "delete-row" },
      enabled: hasCell,
      action: (ctx) => ctx.sheetEditor?.deleteRow()
    }),
    button({
      id: "insert-column",
      label: "Insert column",
      icon: "column-add",
      attrs: { "data-action": "add-column" },
      enabled: hasCell,
      action: (ctx) => ctx.sheetEditor?.insertColumn()
    }),
    button({
      id: "delete-column",
      label: "Delete column",
      icon: "column-delete",
      attrs: { "data-action": "delete-column" },
      enabled: hasCell,
      action: (ctx) => ctx.sheetEditor?.deleteColumn()
    })
  ];
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

/** @returns {Tab} */
function viewTab() {
  return {
    id: "view",
    label: "View",
    groups: [
      {
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
      },
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
            blockType("paragraph", "Text", "paragraph", "paragraph", undefined, "Paragraph"),
            blockType("heading-1", "H1", "h1", "heading", 1, "Heading 1"),
            blockType("heading-2", "H2", "h2", "heading", 2, "Heading 2"),
            blockType("heading-3", "H3", "h3", "heading", 3, "Heading 3"),
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
        { id: "paragraph", label: "Paragraph", controls: [blockType("list", "List", "list", "list")] },
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
            button({
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
            button({
              id: "insert-page-link",
              kind: "menu",
              label: "Page link",
              icon: "page-link",
              attrs: { "data-action": "insert-page-link-menu" },
              enabled: hasDoc,
              items: (ctx) => {
                const others = ctx.workspace.getPages().filter((page) => page.id !== ctx.page?.id);
                if (others.length === 0) return [{ heading: "No other pages" }];
                return [
                  { heading: "Link to page" },
                  ...others.map((page) => ({
                    label: page.title || "Untitled",
                    icon: `page-${page.type}`,
                    attrs: { "data-action": "insert-page-link", "data-page-id": page.id },
                    action: () => ctx.docEditor?.insertAfterActive({ type: "pageLink", pageId: page.id })
                  }))
                ];
              }
            }),
            linkControl("insert-link")
          ]
        },
        {
          id: "embeds",
          label: "Embeds",
          controls: [
            seam({ id: "embed-sheet", label: "Sheet", icon: "sheet", attrs: { "data-action": "embed-sheet" } }, EMBED_REASON),
            seam({ id: "embed-slide", label: "Slide", icon: "slide", attrs: { "data-action": "embed-slide" } }, EMBED_REASON)
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
        { id: "lines", label: "Rows and Columns", controls: lineControls() },
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
        { id: "lines", label: "Rows and Columns", controls: lineControls() }
      ]
    }
  ];
}

/** @returns {Tab[]} */
function presentationTabs() {
  const R = PRESENTATION_REASON;
  /** @param {string} id @param {string} label @param {string} iconName */
  const s = (id, label, iconName) => seam({ id, label, icon: iconName, attrs: { "data-action": id } }, R);
  return [
    {
      id: "home",
      label: "Home",
      groups: [
        { id: "slides", label: "Slides", controls: [s("new-slide", "New slide", "slide-new"), s("layout", "Layout", "layout")] },
        { id: "text", label: "Text", controls: [s("text-box", "Text box", "textbox")] }
      ]
    },
    {
      id: "insert",
      label: "Insert",
      groups: [
        {
          id: "objects",
          label: "Objects",
          controls: [s("insert-image", "Image", "image"), s("insert-shape", "Shape", "shape"), s("insert-line", "Line", "line")]
        }
      ]
    },
    {
      id: "design",
      label: "Design",
      groups: [
        { id: "theme", label: "Theme", controls: [s("theme", "Theme", "theme"), s("background", "Background", "background")] }
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
              options: [{ value: "none", label: "None" }],
              value: () => "none",
              enabled: () => false,
              disabledReason: R
            }
          ]
        }
      ]
    },
    {
      id: "animations",
      label: "Animations",
      groups: [{ id: "animation", label: "Animation", controls: [s("add-animation", "Add animation", "animation")] }]
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
  return [fileTab(), ...own, viewTab()];
}

/**
 * Tab to show first for a page type.
 * @param {string | null | undefined} pageType
 */
export function defaultTabId(pageType) {
  return pageType ? "home" : "file";
}
