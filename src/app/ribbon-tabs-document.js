/**
 * Document tabs of the ribbon.
 */

import { INSERT_BLOCKS, blockType, button, hasDoc, headingMenu, historyControls, linkControl, markToggle, styleSelect } from "./ribbon-shared.js";
/** @typedef {import("./ribbon-shared.js").Tab} Tab */

/** @returns {Tab[]} */
export function documentTabs() {
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
