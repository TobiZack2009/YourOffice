/**
 * The link UI shared by the ribbon popover, Cmd/Ctrl+K and the card that opens when a
 * link is clicked: address cleanup (`normalizeLinkUrl`), the edit form and the card.
 * Pure DOM builders; the owner decides where they open and what applying does.
 */

import { h } from "./dom.js";

/** Schemes that run code or smuggle a document into the page. */
const UNSAFE_SCHEME = /^(javascript|data|vbscript|file):/i;

/**
 * Turn what the user typed into an address worth storing: trimmed, with `https://`
 * added when no scheme was given. Unsafe schemes yield "".
 * @param {string} raw
 * @returns {string}
 */
export function normalizeLinkUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value || UNSAFE_SCHEME.test(value)) return "";
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z0-9.-]+:\d+/i.test(value)) return value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
  return `https://${value}`;
}

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
 * The edit form. The text field shows when a link is being edited or inserted at a bare
 * caret; with a text selection the selection is what gets linked.
 * @param {{
 *   info: LinkInfo,
 *   onApply: (value: { url: string, text: string }) => void,
 *   onRemove: () => void,
 *   close: () => void
 * }} spec
 * @returns {HTMLElement}
 */
export function buildLinkForm({ info, onApply, onRemove, close }) {
  const showText = !info.wholeBlocks && (info.inLink || !info.hasSelection);
  const input = h("input", {
    class: "popover-input",
    type: "text",
    inputmode: "url",
    placeholder: "https://…",
    value: info.url,
    "aria-label": "Link URL",
    "data-role": "link-input"
  });
  const textInput = showText
    ? h("input", {
        class: "popover-input",
        type: "text",
        placeholder: "Text to show",
        value: info.text,
        "aria-label": "Link text",
        "data-role": "link-text-input"
      })
    : null;
  const apply = h("button", { class: "popover-apply", type: "button", "data-action": "link-apply", text: info.inLink ? "Update" : "Apply" });
  const remove = h("button", { class: "popover-remove", type: "button", "data-action": "link-remove", text: "Remove" });
  const message = h("div", { class: "popover-hint", role: "alert", "data-role": "link-error" });

  const submit = () => {
    const url = normalizeLinkUrl(/** @type {HTMLInputElement} */ (input).value);
    if (!url) {
      message.textContent = "Enter a web address, for example https://example.com";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    const text = textInput ? /** @type {HTMLInputElement} */ (textInput).value : "";
    onApply({ url, text });
    close();
  };

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

  const buttons = h("div", { class: "popover-row" }, [apply]);
  if (info.inLink) buttons.append(remove);
  return h("div", { class: "popover-body link-form" }, [input, ...(textInput ? [textInput] : []), message, buttons]);
}

/**
 * The small card shown when a link is clicked: where it goes, plus Edit and Remove.
 * @param {{ url: string, onEdit: () => void, onRemove: () => void }} spec
 * @returns {HTMLElement}
 */
export function buildLinkCard({ url, onEdit, onRemove }) {
  const open = h("a", {
    class: "link-card-url",
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    title: "Open link",
    "data-role": "link-open",
    text: url
  });
  const edit = h("button", { class: "popover-button", type: "button", "data-action": "link-edit", text: "Edit" });
  const remove = h("button", { class: "popover-button", type: "button", "data-action": "link-unlink", text: "Remove" });
  edit.addEventListener("click", onEdit);
  remove.addEventListener("click", onRemove);
  return h("div", { class: "link-card" }, [open, edit, remove]);
}
