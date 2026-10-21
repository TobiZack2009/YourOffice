/**
 * The reference picker: a searchable tree of everything that can be shown elsewhere
 * (pages, then their tables, slides, named sections and, in documents, blocks), with a
 * live preview of the highlighted entry.
 *
 * Choosing a run of blocks that is not a section yet asks for a name first; the
 * caller creates the section (`ensureSection`) inside its own transaction, so one
 * undo removes both the section and the reference.
 */

import { buildCatalog, filterCatalog } from "../references/catalog.js";
import { containerOf } from "../references/containers.js";
import { findSection } from "../references/sections.js";
import { clear, h } from "./dom.js";
import { icon } from "./icons.js";
import { enginesFor, missing, renderBlocksSection, renderSlideSection, renderTableSection } from "../export/static-render.js";

const KIND_ICON = { section: "section", table: "table", slide: "slide", block: "paragraph" };

/**
 * Draw a catalog item read-only.
 * @param {any} data
 * @param {import("../references/catalog.js").CatalogItem} item
 * @returns {HTMLElement}
 */
export function renderPreview(data, item) {
  const ctx = { data, engines: enginesFor(data) };
  const found = item.sectionId
    ? findSection(data, item.sectionId)
    : (() => {
        const container = containerOf(data, item.pageId);
        return container ? { containerId: item.pageId, container, section: { locator: item.locator }, detached: false } : null;
      })();
  if (!found) return missing("Nothing to show.");
  if (item.kind === "block" || (found.section.locator && "startBlockId" in found.section.locator)) {
    return renderBlocksSection(ctx, found);
  }
  if (found.section.locator && "slideId" in found.section.locator) return renderSlideSection(ctx, found, 280);
  return renderTableSection(ctx, found);
}

/**
 * @param {object} options
 * @param {{ data: any }} options.workspace
 * @param {import("./popover.js").PopoverHost} options.popovers
 * @param {HTMLElement} options.anchor
 * @param {string} options.pageId Page the reference is going into.
 * @param {(item: import("../references/catalog.js").CatalogItem, name?: string) => boolean | void} options.onPick
 *   Return false to keep the picker open (after reporting why).
 */
export function openReferencePicker(options) {
  const { workspace, popovers } = options;
  const search = /** @type {HTMLInputElement} */ (
    h("input", { class: "picker-search", type: "text", placeholder: "Search pages and sections", "aria-label": "Search" })
  );
  const tree = h("div", { class: "picker-tree", role: "tree" });
  const preview = h("div", { class: "picker-preview", "data-role": "picker-preview" });
  const body = h("div", { class: "picker-body" }, [tree, preview]);
  const root = h("div", { class: "reference-picker" }, [h("div", { class: "name-prompt-title", text: "Embed" }), search, body]);

  /** @param {import("../references/catalog.js").CatalogItem} item */
  function showPreview(item) {
    clear(preview);
    preview.append(renderPreview(workspace.data, item));
  }

  /** @param {import("../references/catalog.js").CatalogItem} item */
  function askName(item) {
    clear(root);
    const input = /** @type {HTMLInputElement} */ (h("input", { class: "name-prompt-input", type: "text", value: "", "aria-label": "Section name" }));
    const done = () => {
      const name = input.value.trim();
      if (name === "") {
        input.classList.add("is-invalid");
        return;
      }
      if (options.onPick(item, name) === false) return;
      popovers.close();
    };
    input.addEventListener("input", () => input.classList.remove("is-invalid"));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        done();
      } else if (event.key === "Escape") {
        popovers.close();
      }
      event.stopPropagation();
    });
    root.append(
      h("div", { class: "name-prompt-title", text: "Name this section" }),
      h("div", { class: "picker-hint", text: "It has to be a section before it can be shown elsewhere." }),
      input,
      h("div", { class: "name-prompt-actions" }, [
        h("button", { class: "button is-primary", type: "button", "data-action": "picker-name-confirm", text: "Create and embed", onClick: done })
      ])
    );
    input.focus();
  }

  /** @param {import("../references/catalog.js").CatalogItem} item */
  function choose(item) {
    if (item.kind === "block" && !item.sectionId) {
      askName(item);
      return;
    }
    if (options.onPick(item) === false) return;
    popovers.close();
  }

  function renderTree() {
    clear(tree);
    const pages = filterCatalog(buildCatalog(workspace.data), search.value);
    if (pages.length === 0) tree.append(h("div", { class: "picker-empty", text: "Nothing matches." }));
    for (const page of pages) {
      tree.append(
        h("div", { class: "picker-page", style: `padding-left:${8 + page.depth * 12}px`, "data-page-id": page.pageId }, [
          icon(`page-${page.type}`, { size: 14 }),
          h("span", { text: page.title })
        ])
      );
      for (const item of page.items) {
        const row = h(
          "button",
          {
            class: "picker-item",
            type: "button",
            role: "treeitem",
            style: `padding-left:${26 + page.depth * 12}px`,
            "data-key": item.key,
            "data-kind": item.kind,
            "data-page-id": item.pageId
          },
          [icon(KIND_ICON[item.kind], { size: 14 }), h("span", { text: item.label })]
        );
        row.addEventListener("mouseenter", () => showPreview(item));
        row.addEventListener("focus", () => showPreview(item));
        row.addEventListener("click", () => choose(item));
        tree.append(row);
      }
    }
  }

  search.addEventListener("input", renderTree);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") popovers.close();
    event.stopPropagation();
  });

  renderTree();
  popovers.show(options.anchor, root, { keepFocus: true, class: "reference-picker-popover" });
  search.focus();
}
