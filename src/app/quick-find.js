/**
 * Quick find (Cmd/Ctrl+K): a centred overlay that filters pages by title.
 *
 * Arrow keys move the highlight, Enter opens the highlighted page, Escape or a
 * click on the backdrop closes it. Opening a page is delegated to `onSelect`, so
 * the overlay never touches workspace state itself.
 */

import { clear, h } from "./dom.js";
import { icon } from "./icons.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */

const MAX_RESULTS = 50;

/**
 * Pages whose title (or type name) contains every word of the query,
 * case-insensitively. An empty query lists every page in tree order.
 * @param {Workspace} workspace
 * @param {string} query
 * @returns {{ id: string, title: string, type: string, path: string }[]}
 */
export function findPages(workspace, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  /** @type {{ id: string, title: string, type: string, path: string }[]} */
  const results = [];

  /**
   * @param {string | null} parentId
   * @param {string[]} trail
   */
  function walk(parentId, trail) {
    for (const id of workspace.getChildren(parentId)) {
      const page = workspace.getPage(id);
      if (!page) continue;
      const title = page.title || "Untitled";
      const haystack = `${title} ${page.type}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) {
        results.push({ id, title, type: page.type, path: trail.join(" / ") });
      }
      walk(id, [...trail, title]);
    }
  }
  walk(null, []);
  return results.slice(0, MAX_RESULTS);
}

/**
 * @param {Workspace} workspace
 * @param {{ container: HTMLElement, onSelect: (pageId: string) => void }} options
 * @returns {{ open: () => void, close: () => void, isOpen: () => boolean, destroy: () => void }}
 */
export function createQuickFind(workspace, options) {
  /** @type {HTMLElement | null} */
  let overlay = null;
  let highlighted = 0;
  /** @type {ReturnType<typeof findPages>} */
  let results = [];

  function close() {
    overlay?.remove();
    overlay = null;
  }

  function open() {
    if (overlay) {
      /** @type {HTMLInputElement | null} */ (overlay.querySelector(".quick-find-input"))?.focus();
      return;
    }

    const input = /** @type {HTMLInputElement} */ (
      h("input", {
        class: "quick-find-input",
        type: "text",
        placeholder: "Search pages…",
        "aria-label": "Search pages",
        spellcheck: "false"
      })
    );
    const list = h("div", { class: "quick-find-results", role: "listbox" });
    const dialog = h("div", { class: "quick-find", role: "dialog", "aria-label": "Quick find" }, [
      h("div", { class: "quick-find-field" }, [icon("search", { size: 16 }), input]),
      list
    ]);
    overlay = h("div", { class: "quick-find-backdrop" }, [dialog]);

    function renderResults() {
      results = findPages(workspace, input.value);
      highlighted = Math.min(highlighted, Math.max(0, results.length - 1));
      clear(list);
      if (results.length === 0) {
        list.append(h("div", { class: "quick-find-empty", text: "No matching pages" }));
        return;
      }
      results.forEach((result, index) => {
        const item = h(
          "button",
          {
            class: `quick-find-item${index === highlighted ? " is-highlighted" : ""}`,
            type: "button",
            role: "option",
            "data-page-id": result.id
          },
          [
            h("span", { class: `type-glyph type-${result.type}` }, [icon(`page-${result.type}`, { size: 16 })]),
            h("span", { class: "quick-find-title", text: result.title }),
            result.path ? h("span", { class: "quick-find-path", text: result.path }) : null
          ]
        );
        item.addEventListener("click", () => choose(result.id));
        item.addEventListener("mousemove", () => {
          if (highlighted === index) return;
          highlighted = index;
          for (const [at, el] of [...list.children].entries()) el.classList.toggle("is-highlighted", at === index);
        });
        list.append(item);
      });
    }

    /** @param {string} pageId */
    function choose(pageId) {
      close();
      options.onSelect(pageId);
    }

    input.addEventListener("input", () => {
      highlighted = 0;
      renderResults();
    });
    input.addEventListener("keydown", (event) => {
      const key = /** @type {KeyboardEvent} */ (event).key;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        if (results.length === 0) return;
        highlighted = (highlighted + (key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        renderResults();
        list.children[highlighted]?.scrollIntoView?.({ block: "nearest" });
      } else if (key === "Enter") {
        event.preventDefault();
        const target = results[highlighted];
        if (target) choose(target.id);
      } else if (key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close();
    });

    options.container.append(overlay);
    renderResults();
    input.focus();
  }

  return { open, close, isOpen: () => overlay !== null, destroy: close };
}
