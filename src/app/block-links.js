/**
 * Link controls for the document editor: read the link under the caret, set or clear
 * it, open the link form and the card under a clicked link. State shared with the editor
 * arrives through the `ed` kernel it is given.
 */

import { buildLinkCard, buildLinkForm, linkPages, normalizeLinkUrl, NO_LINK, pageIdOfLink } from "./link-form.js";
import { pageInfo } from "../workspace/selectors.js";
import { closestMark, linkable, rangeInside, unwrap } from "./block-marks.js";

/**
 * @param {any} ed Editor kernel: `element`, `hostWorkspace`, `options`, `popovers`, `sel()`, and the
 *   editor functions the controls call (`activeChild`, `activeEditable`, `commitEditable`, ...).
 */
export function createBlockLinks(ed) {
  const { element, hostWorkspace, options, popovers } = ed;
  const { activeChild, activeEditable, commitEditable, notifyActiveChange, selectedKeys, parseKey, blockOf, locateItem, setLinkOnSelection } = ed;

  /**
   * What the link controls need to know: whether the caret is in a link, its address and
   * text, and what is selected.
   * @returns {import("./link-form.js").LinkInfo}
   */
  function getLinkInfo() {
    const child = activeChild();
    if (child) return child.getLinkInfo();
    if (ed.sel()) {
      const urls = new Set();
      for (const key of selectedKeys()) {
        const { blockId, itemId } = parseKey(key);
        const block = blockOf(blockId);
        const runs = itemId ? (locateItem(itemId)?.item.runs ?? []) : (block?.runs ?? []);
        for (const run of runs) if (!run.ref) urls.add(run.marks?.link ?? "");
      }
      const only = urls.size === 1 ? [...urls][0] : "";
      return { canLink: true, inLink: only !== "", url: only, text: "", hasSelection: true, wholeBlocks: true };
    }
    const el = activeEditable();
    if (!el || !linkable(el)) return NO_LINK;
    const range = rangeInside(el);
    const anchor = range ? closestMark(range.commonAncestorContainer, "a", el) : null;
    const hasSelection = Boolean(range && !range.collapsed);
    return {
      canLink: true,
      inLink: Boolean(anchor),
      url: anchor?.getAttribute("href") ?? "",
      text: anchor ? (anchor.textContent ?? "") : hasSelection && range ? range.toString() : "",
      hasSelection,
      wholeBlocks: false
    };
  }

  /**
   * Set, edit or clear a link. Over selected text it links that text; inside a link it
   * changes the address (and the text, when given); at a bare caret with `text` it inserts
   * a new linked piece of text; for "" it removes the link under the selection. With whole
   * blocks selected it links every run in them.
   * @param {string} rawUrl Empty string removes the link.
   * @param {string} [text] Text to show (editing a link, or inserting at a caret).
   * @returns {boolean}
   */
  function setLink(rawUrl, text) {
    const child = activeChild();
    if (child) return child.setLink(rawUrl, text);
    const url = rawUrl ? normalizeLinkUrl(rawUrl) : "";
    if (rawUrl && !url) return false;
    if (ed.sel()) return setLinkOnSelection(url);
    const el = activeEditable();
    if (!el || !linkable(el)) return false;
    const doc = el.ownerDocument;
    const selection = doc.getSelection?.();
    const range = rangeInside(el);
    const intersecting = () =>
      range ? [...el.querySelectorAll("a")].filter((anchor) => range.intersectsNode(anchor)) : [];

    if (!url) {
      const existing = range ? closestMark(range.commonAncestorContainer, "a", el) : null;
      const targets = new Set([...(existing ? [existing] : []), ...(range?.collapsed ? [] : intersecting())]);
      if (targets.size === 0) return false;
      for (const anchor of targets) unwrap(anchor);
    } else {
      const existing = range ? closestMark(range.commonAncestorContainer, "a", el) : null;
      if (existing) {
        existing.setAttribute("href", url);
        if (text && text !== existing.textContent) existing.textContent = text;
      } else if (range && !range.collapsed) {
        const anchor = doc.createElement("a");
        anchor.setAttribute("href", url);
        try {
          // Extracting splits any link the selection only partly covers, so its outside
          // part keeps the old address; the covered part is re-linked below.
          anchor.append(range.extractContents());
          for (const inner of [...anchor.querySelectorAll("a")]) unwrap(inner);
          range.insertNode(anchor);
        } catch {
          return false;
        }
      } else {
        const anchor = doc.createElement("a");
        anchor.setAttribute("href", url);
        anchor.textContent = text || (pageIdOfLink(url) && options.resolvePageTitle?.(pageIdOfLink(url))) || url;
        const at = range ?? doc.createRange();
        if (!range) {
          at.selectNodeContents(el);
          at.collapse(false);
        }
        at.insertNode(anchor);
        const after = doc.createRange();
        after.setStartAfter(anchor);
        after.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(after);
      }
    }

    commitEditable(el);
    notifyActiveChange();
    return true;
  }

  /** @type {boolean} Whether the open popover is the click-on-a-link card. */
  let linkCardOpen = false;

  /**
   * Open the link form at the caret (ribbon, context menu, the link card).
   * @returns {boolean}
   */
  function openLinkEditor() {
    const child = activeChild();
    if (child) return child.openLinkEditor();
    const info = getLinkInfo();
    if (!info.canLink) return false;
    const el = activeEditable();
    const selection = element.ownerDocument.getSelection?.();
    const saved = !ed.sel() && selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    const restore = () => {
      if (!saved || !selection) return;
      selection.removeAllRanges();
      selection.addRange(saved);
    };
    const target = (saved && typeof saved.getBoundingClientRect === "function" ? saved.getBoundingClientRect() : null) ?? { left: 0, bottom: 0, width: 0, height: 0 };
    const box = target.width || target.height ? target : (el ?? element).getBoundingClientRect();
    linkCardOpen = false;
    const close = () => {
      popovers.close();
      restore();
      if (!ed.sel()) el?.focus?.();
    };
    const form = buildLinkForm({
      info,
      pages: linkPages(hostWorkspace),
      onApply: ({ url, text }) => {
        restore();
        setLink(url, text);
      },
      onRemove: () => {
        restore();
        setLink("");
      },
      close
    });
    popovers.showAt({ x: box.left, y: box.bottom + 4 }, form, { class: "popover-dialog", keepFocus: true });
    return true;
  }

  /**
   * The card under a clicked link: where it goes, Edit and Remove.
   * @param {HTMLAnchorElement} anchor
   * @param {HTMLElement} el The editable host holding the link.
   */
  function openLinkCard(anchor, el) {
    const url = anchor.getAttribute("href") ?? "";
    const rect = anchor.getBoundingClientRect();
    const pageId = pageIdOfLink(url);
    const target = pageId ? pageInfo(hostWorkspace, pageId) : undefined;
    const card = buildLinkCard({
      url,
      page: pageId
        ? target
          ? {
              title: target.title || "Untitled",
              type: target.type,
              onOpen: () => {
                popovers.close();
                linkCardOpen = false;
                options.navigate?.(pageId);
              }
            }
          : null
        : undefined,
      onEdit: () => {
        popovers.close();
        linkCardOpen = false;
        openLinkEditor();
      },
      onRemove: () => {
        popovers.close();
        linkCardOpen = false;
        unwrap(anchor);
        commitEditable(el);
        notifyActiveChange();
      }
    });
    popovers.showAt({ x: rect.left, y: rect.bottom + 4 }, card, { class: "popover-dialog link-card-popover" });
    linkCardOpen = true;
  }

  return {
    getLinkInfo,
    setLink,
    openLinkEditor,
    openLinkCard,
    /** @returns {boolean} Whether the click-on-a-link card is open. */
    isCardOpen: () => linkCardOpen,
    /** Close the card if it is open. */
    dismissCard() {
      if (!linkCardOpen) return;
      popovers.close();
      linkCardOpen = false;
    }
  };
}
