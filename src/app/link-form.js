/**
 * The link UI shared by the ribbon popover, the context menu and the card that opens when
 * a link is clicked: address cleanup (`normalizeLinkUrl`), the edit form and the card.
 * One link type covers both destinations: a web address, or another page of the workspace
 * (stored as the href `#<pageId>`). Pure DOM builders; the owner decides where they open
 * and what applying does.
 */

import { isSafeUrl } from "../core/url.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { pageList } from "../workspace/selectors.js";

/**
 * Turn what the user typed into an address worth storing: trimmed, with `https://`
 * added when no scheme was given. Unsafe schemes yield "".
 * @param {string} raw
 * @returns {string}
 */
export function normalizeLinkUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  // "host:8080" reads as a scheme but is an address without one.
  const hostPort = /^[a-z0-9.-]+:\d+/i.test(value);
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(value)) return isSafeUrl(value) ? value : "";
  if (/^(#|\/)/.test(value)) return value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}

/** Page ids look like `document_k3v8…`, `sheet_…`, `pres_…`. */
const PAGE_LINK = /^#([a-z]+_[0-9a-z]+)$/;

/**
 * The page a link address points at, or "" when it is not a page link.
 * @param {string} url
 * @returns {string}
 */
export function pageIdOfLink(url) {
  return PAGE_LINK.exec(String(url ?? ""))?.[1] ?? "";
}

/** @param {string} pageId @returns {string} The address that links to a page. */
export function pageLinkUrl(pageId) {
  return `#${pageId}`;
}

/**
 * @typedef {object} LinkPage
 * @property {string} id
 * @property {string} title
 * @property {string} type document | sheet | presentation
 */

/**
 * Every page of a workspace as link destinations.
 * @param {import("../workspace/store.js").Workspace} workspace
 * @returns {LinkPage[]}
 */
export function linkPages(workspace) {
  return pageList(workspace).map((page) => ({ id: page.id, title: page.title || "Untitled", type: page.type }));
}

/** Whether typed text is an address rather than words to search pages with. */
const looksLikeAddress = (value) => /^[a-z][a-z0-9+.-]*:|[./@#]/i.test(value.trim());

/**
 * @typedef {object} LinkInfo
 * @property {boolean} canLink Whether a link can be set right now.
 * @property {boolean} inLink Whether the caret or selection sits in a link.
 * @property {string} url The link's address ("" when none).
 * @property {string} text The linked text, or the selected text.
 * @property {boolean} hasSelection Whether text (or whole blocks) are selected.
 * @property {boolean} wholeBlocks Whether whole blocks are selected (no text field then).
 */

/** @type {LinkInfo} */
export const NO_LINK = { canLink: false, inLink: false, url: "", text: "", hasSelection: false, wholeBlocks: false };

/**
 * The edit form: one field takes either a web address or the name of a page. Pages that
 * match what is typed are listed underneath; picking one links to it. The text field shows
 * when a link is being edited or inserted at a bare caret; with a text selection the
 * selection is what gets linked.
 * @param {{
 *   info: LinkInfo,
 *   pages?: LinkPage[],
 *   onApply: (value: { url: string, text: string }) => void,
 *   onRemove: () => void,
 *   close: () => void
 * }} spec
 * @returns {HTMLElement}
 */
export function buildLinkForm({ info, pages = [], onApply, onRemove, close }) {
  const showText = !info.wholeBlocks && (info.inLink || !info.hasSelection);
  /** @type {string} The page picked from the list ("" when the field holds an address). */
  let pageId = pageIdOfLink(info.url);
  const picked = pages.find((page) => page.id === pageId);
  if (!picked) pageId = "";
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      class: "popover-input",
      type: "text",
      placeholder: pages.length ? "Web address or page name" : "https://…",
      value: picked ? picked.title : info.url,
      "aria-label": "Link to",
      "data-role": "link-input"
    })
  );
  const textInput = /** @type {HTMLInputElement | null} */ (
    showText
      ? h("input", {
          class: "popover-input",
          type: "text",
          placeholder: "Text to show",
          value: info.text,
          "aria-label": "Link text",
          "data-role": "link-text-input"
        })
      : null
  );
  const list = h("div", { class: "link-pages", role: "listbox", "data-role": "link-pages" });
  const apply = h("button", { class: "popover-apply", type: "button", "data-action": "link-apply", text: info.inLink ? "Update" : "Apply" });
  const remove = h("button", { class: "popover-remove", type: "button", "data-action": "link-remove", text: "Remove" });
  const message = h("div", { class: "popover-hint", role: "alert", "data-role": "link-error" });

  /** The text the form filled in itself, so a later pick may replace it but not the user's own. */
  let autoText = picked && textInput && textInput.value === picked.title ? picked.title : "";

  /** @param {string} query @returns {LinkPage[]} */
  const matches = (query) => {
    const needle = query.trim().toLowerCase();
    if (pageId || !needle) return pages;
    return pages.filter((page) => page.title.toLowerCase().includes(needle));
  };

  const renderList = () => {
    list.replaceChildren();
    const shown = pageId ? pages : matches(input.value);
    for (const page of shown) {
      const item = h(
        "button",
        {
          class: `link-page-item${page.id === pageId ? " is-selected" : ""}`,
          type: "button",
          role: "option",
          "aria-selected": String(page.id === pageId),
          "data-role": "link-page",
          "data-page-id": page.id
        },
        [icon(`page-${page.type}`, { size: 14 }), h("span", { class: "link-page-title", text: page.title })]
      );
      // Keep focus in the field so the editor selection and the caret survive the click.
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => pick(page));
      list.append(item);
    }
    list.hidden = shown.length === 0;
  };

  /** @param {LinkPage} page */
  const pick = (page) => {
    pageId = page.id;
    input.value = page.title;
    input.removeAttribute("aria-invalid");
    message.textContent = "";
    if (textInput && (!textInput.value.trim() || textInput.value === autoText)) {
      textInput.value = page.title;
      autoText = page.title;
    }
    renderList();
  };

  const submit = () => {
    const typed = input.value.trim();
    if (!pageId && typed && !looksLikeAddress(typed)) {
      // Words rather than an address: take the first page they name.
      const first = matches(typed)[0];
      if (first) pick(first);
    }
    const url = pageId ? pageLinkUrl(pageId) : normalizeLinkUrl(typed);
    if (!url) {
      message.textContent = pages.length
        ? "Enter a web address, for example https://example.com, or choose a page"
        : "Enter a web address, for example https://example.com";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    onApply({ url, text: textInput ? textInput.value : "" });
    close();
  };

  input.addEventListener("input", () => {
    pageId = "";
    renderList();
  });
  apply.addEventListener("click", submit);
  remove.addEventListener("click", () => {
    onRemove();
    close();
  });
  for (const field of [input, textInput]) {
    field?.addEventListener("keydown", (event) => {
      const key = /** @type {KeyboardEvent} */ (event).key;
      if (key === "Enter") {
        event.preventDefault();
        submit();
      } else if (key === "Escape") {
        close();
      }
    });
  }
  renderList();

  const buttons = h("div", { class: "popover-row" }, [apply]);
  if (info.inLink) buttons.append(remove);
  return h("div", { class: "popover-body link-form" }, [input, ...(textInput ? [textInput] : []), list, message, buttons]);
}

/**
 * The small card shown when a link is clicked: where it goes, plus Edit and Remove. A page
 * link shows the page's name and a button that opens it instead of an address.
 * @param {{
 *   url: string,
 *   page?: { title: string, type: string, onOpen: () => void } | null,
 *   onEdit: () => void,
 *   onRemove: () => void
 * }} spec `page` is only given for page links; `null` marks one whose page is gone.
 * @returns {HTMLElement}
 */
export function buildLinkCard({ url, page, onEdit, onRemove }) {
  let open;
  if (page === undefined) {
    open = h("a", {
      class: "link-card-url",
      href: url,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Open link",
      "data-role": "link-open",
      text: url
    });
  } else if (page) {
    open = h(
      "button",
      { class: "link-card-url link-card-page", type: "button", title: "Go to page", "data-role": "link-open-page" },
      [icon(`page-${page.type}`, { size: 14 }), h("span", { text: page.title })]
    );
    open.addEventListener("click", page.onOpen);
  } else {
    open = h("span", { class: "link-card-url link-card-missing", "data-role": "link-missing", text: "Page removed" });
  }
  const edit = h("button", { class: "popover-button", type: "button", "data-action": "link-edit", text: "Edit" });
  const remove = h("button", { class: "popover-button", type: "button", "data-action": "link-unlink", text: "Remove" });
  edit.addEventListener("click", onEdit);
  remove.addEventListener("click", onRemove);
  return h("div", { class: "link-card" }, [open, edit, remove]);
}
