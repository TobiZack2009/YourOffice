/**
 * Slide thumbnail strip: the left pane of the presentation editor.
 *
 * It renders one thumbnail per slide (the same `renderSlide` the stage uses, just
 * smaller and non-interactive) and reports intent through callbacks; it never
 * touches the workspace itself. Slide management lives here: click to select,
 * a hover "+" between thumbnails, drag to reorder (the landing spot comes from the
 * pure `planSlideReorder`), a right-click menu, and keyboard handling.
 */

import { LAYOUTS } from "../presentation/layouts.js";
import { planSlideReorder } from "../presentation/geometry.js";
import { renderSlide } from "../presentation/render.js";
import { h, clear } from "./dom.js";
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
 * @property {(slideId: string, index: number) => void} onMove
 * @property {(slideId: string) => number} [referenceCount] How many places read this slide.
 * @property {(slideId: string, anchor: HTMLElement) => void} [onHandle] The section handle was pressed (click-only).
 *
 * @typedef {object} SlideStripHandle
 * @property {HTMLElement} element
 * @property {() => void} render
 * @property {() => void} focus
 */

/**
 * @param {SlideStripOptions} options
 * @returns {SlideStripHandle}
 */
export function createSlideStrip(options) {
  const { popovers } = options;
  const element = h("nav", { class: "slide-strip", tabindex: "0", "aria-label": "Slides", "data-role": "slide-strip" });
  /** @type {string | null} */
  let dragId = null;

  function clearDropMarks() {
    for (const el of element.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  }

  /**
   * @param {string} slideId
   * @param {MouseEvent} event
   * @param {number} index
   */
  function dropTarget(slideId, event, wrap) {
    const rect = wrap.getBoundingClientRect();
    const after = event.clientY - rect.top > rect.height / 2;
    return /** @type {const} */ ({ type: after ? "after" : "before", id: slideId });
  }

  function render() {
    const content = options.getContent();
    const current = options.getCurrent();
    const scrollTop = element.scrollTop;
    clear(element);

    const scale = THUMB_WIDTH / content.size.width;
    const thumbHeight = Math.round(content.size.height * scale);

    content.slideOrder.forEach((slideId, index) => {
      const slide = content.slides[slideId];
      if (!slide) return;
      const thumb = h("div", { class: "slide-thumb" });
      thumb.style.width = `${THUMB_WIDTH}px`;
      thumb.style.height = `${thumbHeight}px`;
      thumb.append(renderSlide(slide, { size: content.size, scale, ...options.slideHooks?.() }));

      const wrap = h("div", {
        class: `slide-thumb-wrap${slideId === current ? " is-current" : ""}`,
        draggable: "true",
        "data-slide-id": slideId,
        "data-index": index,
        role: "button",
        "aria-label": `Slide ${index + 1}`,
        "aria-current": slideId === current ? "true" : "false"
      }, [
        h("span", { class: "slide-number", text: String(index + 1) }),
        thumb
      ]);
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
        const count = options.referenceCount?.(slideId) ?? 0;
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
          options.onHandle?.(slideId, handle);
        });
        handle.addEventListener("mousedown", (event) => event.stopPropagation());
        wrap.append(handle);
      }

      wrap.addEventListener("click", () => options.onSelect(slideId));
      wrap.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (slideId !== options.getCurrent()) options.onSelect(slideId);
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

      element.append(wrap);

      const add = h("button", {
        class: "slide-add",
        type: "button",
        "data-action": "add-slide-after",
        "data-index": index + 1,
        title: "New slide here",
        "aria-label": `New slide after slide ${index + 1}`
      }, [icon("plus", { size: 12 })]);
      add.addEventListener("click", () => options.onCreate({ index: index + 1 }));
      element.append(h("div", { class: "slide-add-gap" }, [add]));
    });

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
        action: () => options.onDuplicate(slideId)
      },
      { separator: true },
      {
        label: "Move up",
        attrs: { "data-action": "move-slide-up" },
        disabled: index <= 0,
        action: () => options.onMove(slideId, index - 1)
      },
      {
        label: "Move down",
        attrs: { "data-action": "move-slide-down" },
        disabled: index === -1 || index >= order.length - 1,
        action: () => options.onMove(slideId, index + 1)
      },
      { separator: true },
      {
        label: "Delete",
        icon: "trash",
        danger: true,
        attrs: { "data-action": "delete-slide" },
        disabled: order.length <= 1,
        action: () => options.onDelete(slideId)
      }
    ];
    popovers.showAt(point, buildMenu(items, popovers.close, (name) => icon(name, { size: 16 })));
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
      if (key.altKey && current && next >= 0 && next < order.length) options.onMove(current, next);
      else if (order[next]) options.onSelect(order[next]);
    } else if (key.key === "Enter") {
      key.preventDefault();
      options.onCreate({ index: index + 1 });
    } else if ((key.key === "Delete" || key.key === "Backspace") && current) {
      key.preventDefault();
      options.onDelete(current);
    } else if (mod && key.key.toLowerCase() === "d" && current) {
      key.preventDefault();
      options.onDuplicate(current);
    }
  });

  render();
  return { element, render, focus: () => element.focus() };
}
