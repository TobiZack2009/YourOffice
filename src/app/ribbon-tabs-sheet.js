/**
 * Sheet tabs of the ribbon.
 */

import { EMBED_REASON, button, hasCell, hasSheet, historyControls, seam, textPopover } from "./ribbon-shared.js";
/** @typedef {import("./ribbon-shared.js").Tab} Tab */

/** @returns {Tab[]} */
export function sheetTabs() {
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
