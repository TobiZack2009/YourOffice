/**
 * Slide thumbnail strip: the left pane of the presentation editor.
 *
 * It renders one thumbnail per slide (the same `renderSlide` the stage uses, just
 * smaller and non-interactive) and reports intent through callbacks; it never
 * touches the workspace itself. Slide management lives here: click to select,
 * a hover "+" between thumbnails, drag to reorder (the landing spot comes from the
 * pure `planSlideReorder`), a right-click menu, and keyboard handling.
 *
 * Several slides can be selected at once (Shift+click for a range from the anchor,
 * Cmd/Ctrl+click to toggle, Shift+Arrow to extend). The strip owns that set; the
 * editor only learns of it through `onDeleteMany` and `onHandle`. The current slide is
 * always part of a selection of more than one, and moving the current slide elsewhere
 * (a plain click, a plain arrow) ends it. Dragging still moves a single slide.
 */

import { LAYOUTS } from "../presentation/layouts.js";
import { planSlideReorder } from "../presentation/geometry.js";
import { renderSlide } from "../presentation/render.js";
import { reconcileChildren } from "../core/reconcile.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { buildMenu } from "./popover.js";

export const THUMB_WIDTH = 168;

/**
 * @typedef {object} SlideStripOptions
 * @property {() => import("../presentation/model.js").PresentationContent} getContent
 * @property {() => string | null} getCurrent
 * @property {import("./popover.js").PopoverHost} popovers
 * @property {() => Partial<import("../presentation/render.js").RenderSlideOptions>} [slideHooks] How thumbnails draw references.
 * @property {(slideId: string) => void} onSelect
 * @property {(spec: { layout?: string, index: number }) => void} onCreate
 * @property {(slideId: string) => void} onDuplicate
 * @property {(slideId: string) => void} onDelete
 * @property {(slideIds: string[]) => void} [onDeleteMany] Delete a multi-selection (in presentation order).
 * @property {(slideId: string, index: number) => void} onMove
 * @property {(slideId: string) => number} [referenceCount] How many places read this slide.
 * @property {(slideIds: string[], anchor: HTMLElement) => void} [onHandle] The section handle was pressed (click-only); several ids when it belongs to a multi-selection, in presentation order.
 *
 * @typedef {object} SlideStripHandle
 * @property {HTMLElement} element
 * @property {() => void} render
 * @property {() => void} focus
 * @property {() => string[]} getSelection The selected slides in presentation order (the current one when alone).
 */

/**
 * @param {SlideStripOptions} options
 * @returns {SlideStripHandle}
 */
export function createSlideStrip(options) {
  const { popovers } = options;
  const element = h("nav", { class: "slide-strip", tabindex: "0", "aria-label": "Slides", "data-role": "slide-strip", "data-history": "model" });
  /** @type {string | null} */
  let dragId = null;
  /** @type {Set<string>} Selected slides when more than one; empty otherwise. */
  const selected = new Set();
  /** @type {string | null} Where a Shift range starts. */
  let anchorId = null;

  /** Drop ids that vanished, and the selection when it no longer holds the current slide. */
  function pruneSelection() {
    const content = options.getContent();
    for (const id of [...selected]) if (!content.slides[id]) selected.delete(id);
    const current = options.getCurrent();
    if (selected.size < 2 || (current && !selected.has(current))) selected.clear();
    if (selected.size === 0 && current) anchorId = current;
  }

  /** @returns {string[]} */
  function getSelection() {
    pruneSelection();
    const order = options.getContent().slideOrder;
    if (selected.size > 1) return order.filter((id) => selected.has(id));
    const current = options.getCurrent();
    return current ? [current] : [];
  }

  /**
   * Select the run between the anchor and `toId`; `toId` becomes the current slide.
   * @param {string} toId
   */
  function selectRange(toId) {
    const order = options.getContent().slideOrder;
    const from = order.indexOf(anchorId ?? options.getCurrent() ?? toId);
    const to = order.indexOf(toId);
    if (from === -1 || to === -1) return;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    selected.clear();
    for (const id of order.slice(lo, hi + 1)) selected.add(id);
    options.onSelect(toId);
    pruneSelection();
    render();
  }

  /** @param {string} slideId */
  function toggleInSelection(slideId) {
    const current = options.getCurrent();
    if (selected.size === 0 && current) selected.add(current);
    if (selected.has(slideId)) {
      selected.delete(slideId);
      if (slideId === current) {
        const next = options.getContent().slideOrder.find((id) => selected.has(id));
        if (next) options.onSelect(next);
      }
    } else {
      selected.add(slideId);
      options.onSelect(slideId);
    }
    anchorId = slideId;
    pruneSelection();
    render();
  }

  /** @param {string} slideId @param {MouseEvent} event */
  function clickSlide(slideId, event) {
    if (event.shiftKey) selectRange(slideId);
    else if (event.metaKey || event.ctrlKey) toggleInSelection(slideId);
    else {
      const had = selected.size > 0;
      selected.clear();
      anchorId = slideId;
      options.onSelect(slideId);
      if (had) render();
    }
  }

  function clearDropMarks() {
    for (const el of element.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  }

  /**
   * @param {string} slideId
   * @param {MouseEvent} event
   * @param {HTMLElement} wrap
   */
  function dropTarget(slideId, event, wrap) {
    const rect = wrap.getBoundingClientRect();
    const after = event.clientY - rect.top > rect.height / 2;
    return /** @type {const} */ ({ type: after ? "after" : "before", id: slideId });
  }

  /**
   * One cached thumbnail per slide: the wrap, the add gap after it, and what they were drawn
   * from. A slide whose data did not change keeps its nodes; only position-dependent text and
   * the current/selected marks are patched.
   * @type {Map<string, { signature: string | null, wrap: HTMLElement, gap: HTMLElement, number: HTMLElement, add: HTMLElement, index: number }>}
   */
  const views = new Map();

  /**
   * What a thumbnail's content depends on, or null when it draws references (it reads other
   * pages, so it is redrawn on every pass).
   * @param {import("../presentation/model.js").Slide} slide
   * @param {{ width: number, height: number }} size
   * @param {number} count Places that read the slide.
   */
  function signatureOf(slide, size, count) {
    for (const id of slide.objectOrder) {
      const object = slide.objects[id];
      if (!object) continue;
      if (object.type === "reference" || (object.text?.runs ?? []).some((run) => run.ref)) return null;
    }
    return JSON.stringify([slide, size, count, Boolean(options.onHandle)]);
  }

  /**
   * @param {import("../presentation/model.js").Slide} slide
   * @param {import("../presentation/model.js").PresentationContent} content
   * @param {number} count
   */
  function buildView(slide, content, count) {
    const slideId = slide.id;
    const scale = THUMB_WIDTH / content.size.width;
    const thumb = h("div", { class: "slide-thumb" });
    thumb.style.width = `${THUMB_WIDTH}px`;
    thumb.style.height = `${Math.round(content.size.height * scale)}px`;
    thumb.append(renderSlide(slide, { size: content.size, scale, ...options.slideHooks?.() }));

    const number = h("span", { class: "slide-number" });
    const wrap = h("div", { class: "slide-thumb-wrap", draggable: "true", "data-slide-id": slideId, role: "button" }, [number, thumb]);
    if (slide.transition.style !== "none") {
      wrap.append(h("span", {
        class: "transition-badge",
        "data-role": "transition-badge",
        title: `Transition: ${slide.transition.style}`
      }, [icon("transition", { size: 12 })]));
    }
    const animationCount = slide.animationOrder?.length ?? 0;
    if (animationCount > 0) {
      wrap.append(h("span", {
        class: `animation-badge${slide.transition.style !== "none" ? " has-transition" : ""}`,
        "data-role": "animation-badge",
        title: `${animationCount} animation${animationCount === 1 ? "" : "s"}`
      }, [icon("animation", { size: 12 })]));
    }

    if (options.onHandle) {
      const handle = h("button", {
        class: `section-handle slide-handle${count > 0 ? " has-references" : ""}`,
        type: "button",
        draggable: "false",
        "data-role": "slide-handle",
        "aria-label": "Slide section options",
        title: "Slide section options"
      }, [icon("section", { size: 12 })]);
      if (count > 0) handle.append(h("span", { class: "handle-badge", text: String(count) }));
      handle.addEventListener("click", (event) => {
        event.stopPropagation();
        options.onHandle?.(selected.has(slideId) ? getSelection() : [slideId], handle);
      });
      handle.addEventListener("mousedown", (event) => event.stopPropagation());
      wrap.append(handle);
    }

    wrap.addEventListener("click", (event) => clickSlide(slideId, event));
    wrap.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!selected.has(slideId)) {
        selected.clear();
        anchorId = slideId;
        if (slideId !== options.getCurrent()) options.onSelect(slideId);
        else render();
      }
      openMenu({ x: event.clientX, y: event.clientY }, slideId);
    });
    wrap.addEventListener("dragstart", (event) => {
      dragId = slideId;
      wrap.classList.add("is-dragging");
      /** @type {DragEvent} */ (event).dataTransfer?.setData("text/plain", slideId);
    });
    wrap.addEventListener("dragend", () => {
      dragId = null;
      wrap.classList.remove("is-dragging");
      clearDropMarks();
    });
    wrap.addEventListener("dragover", (event) => {
      if (!dragId) return;
      event.preventDefault();
      clearDropMarks();
      const target = dropTarget(slideId, /** @type {MouseEvent} */ (event), wrap);
      if (planSlideReorder(options.getContent().slideOrder, dragId, target)) {
        wrap.classList.add(target.type === "after" ? "drop-after" : "drop-before");
      }
    });
    wrap.addEventListener("drop", (event) => {
      if (!dragId) return;
      event.preventDefault();
      const dragged = dragId;
      const target = dropTarget(slideId, /** @type {MouseEvent} */ (event), wrap);
      dragId = null;
      clearDropMarks();
      const plan = planSlideReorder(options.getContent().slideOrder, dragged, target);
      if (plan) options.onMove(dragged, plan.index);
    });

    const add = h("button", { class: "slide-add", type: "button", "data-action": "add-slide-after", title: "New slide here" }, [icon("plus", { size: 12 })]);
    const view = { signature: null, wrap, gap: h("div", { class: "slide-add-gap" }, [add]), number, add, index: 0 };
    add.addEventListener("click", () => options.onCreate({ index: view.index + 1 }));
    return view;
  }

  function render() {
    const content = options.getContent();
    pruneSelection();
    const current = options.getCurrent();
    const scrollTop = element.scrollTop;

    /** @type {HTMLElement[]} */
    const nodes = [];
    const seen = new Set();
    content.slideOrder.forEach((slideId, index) => {
      const slide = content.slides[slideId];
      if (!slide) return;
      const count = options.onHandle ? options.referenceCount?.(slideId) ?? 0 : 0;
      const signature = signatureOf(slide, content.size, count);
      let view = views.get(slideId);
      if (!view || signature === null || view.signature !== signature) {
        const fresh = buildView(slide, content, count);
        fresh.signature = signature;
        views.set(slideId, fresh);
        view = fresh;
      }
      seen.add(slideId);
      view.index = index;
      const { wrap, number, add } = view;
      wrap.classList.toggle("is-current", slideId === current);
      wrap.classList.toggle("is-selected", selected.has(slideId));
      wrap.dataset.index = String(index);
      wrap.setAttribute("aria-label", `Slide ${index + 1}`);
      wrap.setAttribute("aria-current", slideId === current ? "true" : "false");
      wrap.setAttribute("aria-selected", selected.has(slideId) ? "true" : "false");
      if (number.textContent !== String(index + 1)) number.textContent = String(index + 1);
      add.dataset.index = String(index + 1);
      add.setAttribute("aria-label", `New slide after slide ${index + 1}`);
      nodes.push(wrap, view.gap);
    });
    for (const id of [...views.keys()]) if (!seen.has(id)) views.delete(id);
    reconcileChildren(element, nodes);

    element.scrollTop = scrollTop;
    const currentEl = element.querySelector(".slide-thumb-wrap.is-current");
    /** @type {any} */ (currentEl)?.scrollIntoView?.({ block: "nearest" });
  }

  /**
   * @param {{ x: number, y: number }} point
   * @param {string} slideId
   */
  function openMenu(point, slideId) {
    const order = options.getContent().slideOrder;
    const index = order.indexOf(slideId);
    const group = selected.has(slideId) ? getSelection() : [];
    const many = group.length > 1;
    /** @type {import("./popover.js").MenuItem[]} */
    const items = [
      {
        label: "New slide",
        icon: "slide-new",
        attrs: { "data-action": "new-slide" },
        submenu: LAYOUTS.map((layout) => ({
          label: layout.label,
          icon: "layout",
          attrs: { "data-action": "new-slide-layout", "data-layout": layout.id },
          action: () => options.onCreate({ layout: layout.id, index: index + 1 })
        }))
      },
      {
        label: "Duplicate",
        icon: "duplicate",
        attrs: { "data-action": "duplicate-slide" },
        disabled: many,
        action: () => options.onDuplicate(slideId)
      },
      { separator: true },
      {
        label: "Move up",
        attrs: { "data-action": "move-slide-up" },
        disabled: many || index <= 0,
        action: () => options.onMove(slideId, index - 1)
      },
      {
        label: "Move down",
        attrs: { "data-action": "move-slide-down" },
        disabled: many || index === -1 || index >= order.length - 1,
        action: () => options.onMove(slideId, index + 1)
      },
      { separator: true },
      {
        label: many ? `Delete ${group.length} slides` : "Delete",
        icon: "trash",
        danger: true,
        attrs: { "data-action": "delete-slide" },
        disabled: order.length <= (many ? group.length : 1),
        action: () => (many ? deleteGroup(group) : options.onDelete(slideId))
      }
    ];
    popovers.showAt(point, buildMenu(items, popovers.close, (name) => icon(name, { size: 16 })));
  }

  /** @param {string[]} ids */
  function deleteGroup(ids) {
    selected.clear();
    if (options.onDeleteMany) options.onDeleteMany(ids);
    else for (const id of ids) options.onDelete(id);
  }

  element.addEventListener("keydown", (event) => {
    const key = /** @type {KeyboardEvent} */ (event);
    const order = options.getContent().slideOrder;
    const current = options.getCurrent();
    const index = current ? order.indexOf(current) : -1;
    const mod = key.metaKey || key.ctrlKey;
    if (key.key === "ArrowDown" || key.key === "ArrowUp") {
      key.preventDefault();
      const next = key.key === "ArrowDown" ? index + 1 : index - 1;
      if (key.shiftKey && order[next]) selectRange(order[next]);
      else if (key.altKey && current && next >= 0 && next < order.length) options.onMove(current, next);
      else if (order[next]) {
        selected.clear();
        options.onSelect(order[next]);
        render();
      }
    } else if (key.key === "Enter") {
      key.preventDefault();
      options.onCreate({ index: index + 1 });
    } else if ((key.key === "Delete" || key.key === "Backspace") && current) {
      key.preventDefault();
      const group = getSelection();
      if (group.length > 1) deleteGroup(group);
      else options.onDelete(current);
    } else if (mod && key.key.toLowerCase() === "a") {
      key.preventDefault();
      selected.clear();
      for (const id of order) selected.add(id);
      anchorId = order[0] ?? null;
      pruneSelection();
      render();
    } else if (mod && key.key.toLowerCase() === "d" && current && getSelection().length === 1) {
      key.preventDefault();
      options.onDuplicate(current);
    }
  });

  render();
  return { element, render, focus: () => element.focus(), getSelection };
}
