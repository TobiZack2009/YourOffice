/**
 * Drawing the document for the block editor. Top-level blocks are keyed by id and carry a
 * signature of what they were drawn from; a block whose data is unchanged keeps its element,
 * and one the user is typing in or composing in is never replaced. State shared with the
 * editor arrives through the `ed` kernel.
 */

import { reconcileChildren } from "../core/reconcile.js";
import { renderBlock, renderRuns } from "../document/render.js";
import { h } from "./dom.js";
import { placeCaret } from "./block-caret.js";
import { normalizeText, parseInlineRuns, runsEqual } from "./inline.js";

/** @typedef {import("../document/model.js").Block} Block */

/** @param {any} ed Editor kernel (see `createDocumentEditor`). */
export function createBlockView(ed) {
  const { element, renderOptions, views, content, blockOf, unitKey, owns } = ed;

  /**
   * @param {Block} block
   * @returns {HTMLElement | null}
   */
  function renderEditable(block) {
    if (block.type === "paragraph" || block.type === "quote") {
      const element_ = document.createElement(block.type === "quote" ? "blockquote" : "p");
      decorateEditable(element_, block, "Write…");
      element_.append(renderRuns(block.runs ?? [], renderOptions));
      return element_;
    }
    if (block.type === "heading") {
      const level = Math.min(3, Math.max(1, block.level ?? 1));
      const element_ = document.createElement(`h${level}`);
      decorateEditable(element_, block, "Heading");
      element_.append(renderRuns(block.runs ?? [], renderOptions));
      return element_;
    }
    if (block.type === "list") {
      const element_ = document.createElement(block.ordered ? "ol" : "ul");
      element_.className = "block block-list";
      element_.setAttribute("data-block-id", block.id);
      element_.setAttribute("data-block-type", "list");
      for (const item of block.items ?? []) {
        const li = document.createElement("li");
        const row = document.createElement("div");
        row.className = "block-item";
        row.setAttribute("contenteditable", "true");
        row.setAttribute("data-block-id", block.id);
        row.setAttribute("data-item-id", item.id);
        row.setAttribute("data-unit", unitKey(block.id, item.id));
        if ((item.runs ?? []).length === 0) row.setAttribute("data-placeholder", "List item");
        row.append(renderRuns(item.runs ?? [], renderOptions));
        li.append(row);
        if (item.children && item.children.length > 0) {
          const nested = document.createElement("div");
          nested.className = "item-children";
          for (const childId of item.children) {
            const child = blockOf(childId);
            const rendered = child ? renderEditable(child) : null;
            if (rendered) nested.append(rendered);
          }
          li.append(nested);
        }
        element_.append(li);
      }
      return element_;
    }
    if (block.type === "code") {
      const pre = document.createElement("pre");
      pre.className = "block block-code";
      pre.setAttribute("data-block-id", block.id);
      pre.setAttribute("data-block-type", "code");
      pre.setAttribute("data-unit", block.id);
      const code = document.createElement("code");
      code.setAttribute("contenteditable", "true");
      code.setAttribute("spellcheck", "false");
      code.setAttribute("data-block-id", block.id);
      code.setAttribute("data-placeholder", "Code");
      code.textContent = block.text ?? "";
      pre.append(code);
      // Clicking the padding around the code should still land the caret in it.
      pre.addEventListener("mousedown", (event) => {
        if (event.target === pre) {
          event.preventDefault();
          placeCaret(code, "end");
        }
      });
      return pre;
    }
    const rendered = renderBlock(block, renderOptions);
    if (!rendered) return null;
    rendered.classList.add("block");
    rendered.setAttribute("data-unit", block.id);
    return rendered;
  }

  /**
   * @param {HTMLElement} element_
   * @param {Block} block
   * @param {string} placeholder
   */
  function decorateEditable(element_, block, placeholder) {
    element_.className = `block block-editable block-${block.type}`;
    element_.setAttribute("contenteditable", "true");
    element_.setAttribute("data-block-id", block.id);
    element_.setAttribute("data-block-type", block.type);
    element_.setAttribute("data-unit", block.id);
    if (((block.runs ?? []).length === 0)) element_.setAttribute("data-placeholder", placeholder);
  }

  /**
   * What decides how a top-level block looks, as a string; null when the block draws something
   * that depends on more than its own data (a reference, a page link) and so is drawn on every pass.
   * @param {Block} block
   * @returns {string | null}
   */
  function blockSignature(block) {
    /** @type {Block[]} */
    const parts = [];
    /** @param {Block} candidate @returns {boolean} */
    const visit = (candidate) => {
      if (candidate.type === "pageLink" || candidate.type === "sectionRef") return false;
      if ((candidate.runs ?? []).some((run) => run.ref)) return false;
      for (const item of candidate.items ?? []) {
        if ((item.runs ?? []).some((run) => run.ref)) return false;
        for (const childId of item.children ?? []) {
          const child = blockOf(childId);
          if (child && !visit(child)) return false;
        }
      }
      parts.push(candidate);
      return true;
    };
    return visit(block) ? JSON.stringify(parts) : null;
  }

  /**
   * Whether a drawn block should be left exactly as it is although the model changed: the user
   * is composing in it, or it has the caret and already shows what the model now says (their own
   * typing, round-tripped). Replacing it would drop the caret or break an input method.
   * @param {HTMLElement} el
   * @param {Block} block
   * @returns {boolean}
   */
  function userOwns(el, block) {
    if (composing && el.contains(composing)) return true;
    const active = element.ownerDocument.activeElement;
    if (!active || !el.contains(active) || !owns(active)) return false;
    if (block.type === "code") {
      return el.getAttribute("data-block-type") === "code" && normalizeText(active.textContent ?? "") === (block.text ?? "");
    }
    if (block.type !== "paragraph" && block.type !== "quote" && block.type !== "heading") return false;
    const tag = block.type === "quote" ? "blockquote" : block.type === "heading" ? `h${Math.min(3, Math.max(1, block.level ?? 1))}` : "p";
    if (el !== active || el.tagName.toLowerCase() !== tag) return false;
    if (!runsEqual(block.runs ?? [], parseInlineRuns(el))) return false;
    if ((block.runs ?? []).length === 0) el.setAttribute("data-placeholder", block.type === "heading" ? "Heading" : "Write…");
    else el.removeAttribute("data-placeholder");
    return true;
  }

  const STALE = "\u0000stale";
  /** @type {Map<string, { signature: string, el: HTMLElement }>} Drawn top-level blocks by block id. */
  const blockViews = new Map();
  /** @type {Node | null} Where an input-method composition is going on. */
  let composing = null;
  element.addEventListener("compositionstart", (event) => {
    composing = /** @type {Node | null} */ (event.target);
  });
  element.addEventListener("compositionend", () => {
    composing = null;
  });

  /**
   * Mark drawn blocks as no longer matching the model they were drawn from (the user typed in
   * them), so the next pass re-examines them instead of trusting the cached signature.
   * @param {Set<string> | null} ids Touched entity ids, or null for every block.
   */
  function staleViews(ids) {
    if (!ids) {
      for (const entry of blockViews.values()) entry.signature = STALE;
      return;
    }
    for (const id of ids) {
      for (const node of element.querySelectorAll(`[data-block-id="${id}"], [data-item-id="${id}"]`)) {
        let top = /** @type {Node | null} */ (node);
        while (top && top.parentNode !== element) top = top.parentNode;
        for (const entry of blockViews.values()) if (entry.el === top) entry.signature = STALE;
      }
    }
  }

  /**
   * Draw the document. Blocks are keyed by id: one whose data is unchanged keeps its element,
   * so typing elsewhere, or an undo of one block, leaves the rest (and the caret) alone.
   */
  function render() {
    ed.resetHandle();
    views.begin();
    const c = content();
    const blocks = c.blockOrder.map((id) => c.blocks[id]).filter(Boolean);
    if (blocks.length === 0) {
      views.end();
      blockViews.clear();
      const start = h("div", { class: "empty-document", text: "Start writing…" });
      start.addEventListener("mousedown", (event) => {
        event.preventDefault();
        ed.insertAtEnd({ type: "paragraph" });
      });
      reconcileChildren(element, [start]);
      ed.applySelection();
      return;
    }
    /** @type {Node[]} */
    const nodes = [];
    const live = new Set();
    for (const block of blocks) {
      live.add(block.id);
      const signature = blockSignature(block);
      const entry = blockViews.get(block.id);
      if (entry && signature !== null && entry.signature === signature) {
        nodes.push(entry.el);
        continue;
      }
      if (entry && userOwns(entry.el, block)) {
        entry.signature = signature ?? "";
        nodes.push(entry.el);
        continue;
      }
      const el = renderEditable(block);
      if (!el) {
        blockViews.delete(block.id);
        continue;
      }
      blockViews.set(block.id, { signature: signature ?? "", el });
      nodes.push(el);
    }
    for (const id of blockViews.keys()) if (!live.has(id)) blockViews.delete(id);
    views.end();
    const handle = ed.blockHandle();
    if (handle) nodes.push(handle);
    reconcileChildren(element, nodes);
    ed.applySelection();
  }

  return { render, staleViews };
}
