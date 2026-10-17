/**
 * Animation timeline: an ordered list of the current slide's animations, shown under
 * the stage while the Animations ribbon tab is active.
 *
 * Like the slide strip it renders from the model and reports intent through
 * callbacks. Rows reorder by drag (the landing spot comes from the pure
 * `planSlideReorder`, which only needs an id order) and by the up/down buttons.
 */

import { planSlideReorder } from "../presentation/geometry.js";
import { ANIMATION_DEFAULTS, ANIM_MAX_MS } from "../presentation/model.js";
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { runsToPlainText } from "./inline.js";

/** Display names for the effects. */
export const EFFECT_LABELS = {
  appear: "Appear",
  "fade-in": "Fade in",
  "slide-in": "Slide in",
  motion: "Motion"
};

export const TRIGGER_LABELS = {
  click: "On click",
  with: "With previous",
  after: "After previous"
};

const DIRECTION_LABELS = { left: "From left", right: "From right", up: "From top", down: "From bottom" };

const TRIGGER_ICONS = { click: "on-click", with: "with-previous", after: "after-previous" };

const LABEL_LENGTH = 28;

/**
 * A short human label for an object: its name, its text, or its kind.
 * @param {import("../presentation/model.js").SlideObject | undefined} object
 * @returns {string}
 */
export function objectLabel(object) {
  if (!object) return "Missing object";
  if (object.name) return object.name;
  const text = object.text ? runsToPlainText(object.text.runs).replace(/\s+/g, " ").trim() : "";
  if (text) return text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text;
  if (object.type === "shape") return { rect: "Rectangle", ellipse: "Ellipse", triangle: "Triangle", roundRect: "Rounded rectangle", arrow: "Arrow" }[object.shape ?? "rect"] ?? "Shape";
  return { text: "Text box", line: "Line", image: "Image" }[object.type] ?? "Object";
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatMs(ms) {
  return `${Math.round((ms / 1000) * 100) / 100}s`;
}

/**
 * @param {import("../presentation/model.js").Animation} animation
 * @returns {string}
 */
export function effectLabel(animation) {
  const base = EFFECT_LABELS[animation.effect] ?? animation.effect;
  if (animation.effect === "slide-in" && animation.direction) {
    return `${base} from ${animation.direction === "up" ? "top" : animation.direction === "down" ? "bottom" : animation.direction}`;
  }
  return base;
}

/**
 * Patch for switching an effect. A duration still at the old effect's default follows the new
 * effect's default, so Appear (0 ms) to Fade in does not stay instant.
 * @param {import("../presentation/model.js").Animation} animation
 * @param {string} effect
 * @returns {Record<string, unknown>}
 */
export function effectPatch(animation, effect) {
  const defaults = /** @type {Record<string, number>} */ (ANIMATION_DEFAULTS.duration);
  return animation.duration === defaults[animation.effect] && effect in defaults
    ? { effect, duration: defaults[effect] }
    : { effect };
}

/**
 * @param {string} field
 * @param {string} label
 * @param {[string, string][]} options value/label pairs
 * @param {string} value
 * @param {(value: string) => void} onChange
 * @returns {HTMLSelectElement}
 */
function inlineSelect(field, label, options, value, onChange) {
  const select = /** @type {HTMLSelectElement} */ (
    h("select", { class: `animation-field animation-${field}-select`, "data-field": field, "aria-label": label, title: label })
  );
  for (const [optionValue, optionLabel] of options) select.append(h("option", { value: optionValue, text: optionLabel }));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/**
 * Milliseconds field: commits on change (Enter or blur), Escape reverts.
 * @param {string} field
 * @param {string} label
 * @param {number} value
 * @param {(value: number) => void} onCommit
 * @param {() => void} onRevert
 * @returns {HTMLInputElement}
 */
function inlineMs(field, label, value, onCommit, onRevert) {
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      class: "animation-field animation-ms",
      type: "number",
      min: "0",
      max: String(ANIM_MAX_MS),
      step: "50",
      "data-field": field,
      "aria-label": label,
      title: label,
      value: String(value)
    })
  );
  // Enter commits through a synthetic change; the blur caused by the resulting
  // re-render would otherwise fire a second, native one mid-rebuild.
  let handled = String(value);
  input.addEventListener("change", () => {
    if (input.value === handled) return;
    handled = input.value;
    const next = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(next)) onRevert();
    else onCommit(next);
  });
  input.addEventListener("keydown", (event) => {
    const key = /** @type {KeyboardEvent} */ (event).key;
    if (key === "Enter") {
      event.preventDefault();
      input.dispatchEvent(new Event("change"));
    } else if (key === "Escape") {
      event.stopPropagation();
      input.value = String(value);
      input.blur();
    }
  });
  return input;
}

/**
 * @typedef {object} TimelineApi
 * @property {() => import("../presentation/model.js").Slide | null} getSlide
 * @property {() => string | null} getSelectedId
 * @property {() => boolean} isPreviewing
 * @property {(id: string) => void} onSelect
 * @property {(id: string, index: number) => void} onMove
 * @property {(id: string, patch: Record<string, unknown>) => boolean | void} onUpdate false when the edit was refused
 * @property {(id: string) => void} onDelete
 * @property {() => void} onTogglePreview
 *
 * @typedef {object} TimelineHandle
 * @property {HTMLElement} element
 * @property {() => void} render
 * @property {() => void} select Re-mark the selected row in place (no rebuild, so open fields keep focus).
 */

/**
 * @param {TimelineApi} api
 * @returns {TimelineHandle}
 */
export function createAnimationTimeline(api) {
  const element = h("section", {
    class: "animation-timeline",
    tabindex: "0",
    "aria-label": "Animations",
    "data-role": "animation-timeline"
  });
  /** @type {string | null} */
  let dragId = null;

  function clearDropMarks() {
    for (const el of element.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  }

  /**
   * @param {string} id
   * @param {MouseEvent} event
   * @param {HTMLElement} row
   */
  function dropTarget(id, event, row) {
    const rect = row.getBoundingClientRect();
    return /** @type {const} */ ({ type: event.clientY - rect.top > rect.height / 2 ? "after" : "before", id });
  }

  /** The inline control that has focus, so a re-render can put the caret back. */
  function focusedField() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !element.contains(active) || !active.dataset.field) return null;
    const row = /** @type {HTMLElement | null} */ (active.closest("[data-animation-id]"));
    if (!row) return null;
    return { id: row.dataset.animationId, field: active.dataset.field };
  }

  /**
   * @param {string} id
   * @param {Record<string, unknown>} patch
   */
  function update(id, patch) {
    if (api.onUpdate(id, patch) === false) render();
  }

  function select() {
    const selected = api.getSelectedId();
    for (const row of element.querySelectorAll(".animation-row")) {
      const on = /** @type {HTMLElement} */ (row).dataset.animationId === selected;
      row.classList.toggle("is-selected", on);
      row.setAttribute("aria-current", on ? "true" : "false");
    }
  }

  let rendering = false;

  function render() {
    if (rendering) return;
    rendering = true;
    try {
      build();
    } finally {
      rendering = false;
    }
  }

  function build() {
    const slide = api.getSlide();
    const order = slide?.animationOrder ?? [];
    const previewing = api.isPreviewing();
    const selected = api.getSelectedId();
    const scrollTop = element.scrollTop;
    const focus = focusedField();
    clear(element);

    const toggle = h("button", {
      class: "timeline-preview",
      type: "button",
      "data-action": "timeline-preview",
      "aria-pressed": previewing ? "true" : "false",
      disabled: !previewing && order.length === 0
    }, [icon(previewing ? "stop" : "play", { size: 14 }), h("span", { text: previewing ? "Stop" : "Preview" })]);
    toggle.addEventListener("click", () => api.onTogglePreview());

    element.append(h("header", { class: "timeline-header" }, [
      h("span", { class: "timeline-title", text: "Timeline" }),
      h("span", { class: "timeline-count", "data-role": "timeline-count", text: String(order.length) }),
      toggle
    ]));

    if (!slide || order.length === 0) {
      element.append(h("p", {
        class: "timeline-empty",
        "data-role": "timeline-empty",
        text: "No animations on this slide. Select an object, then pick an effect."
      }));
      return;
    }

    const list = h("div", { class: "timeline-list", role: "list" });
    order.forEach((id, index) => {
      const animation = slide.animations[id];
      if (!animation) return;
      const object = slide.objects[animation.objectId];

      const up = h("button", {
        class: "timeline-button",
        type: "button",
        "data-action": "animation-up",
        title: "Move earlier",
        "aria-label": "Move earlier",
        disabled: index === 0
      }, [icon("move-up", { size: 14 })]);
      const down = h("button", {
        class: "timeline-button",
        type: "button",
        "data-action": "animation-down",
        title: "Move later",
        "aria-label": "Move later",
        disabled: index === order.length - 1
      }, [icon("move-down", { size: 14 })]);
      const remove = h("button", {
        class: "timeline-button",
        type: "button",
        "data-action": "animation-delete",
        title: "Remove animation",
        "aria-label": "Remove animation"
      }, [icon("trash", { size: 14 })]);

      const row = h("div", {
        class: `animation-row${id === selected ? " is-selected" : ""}`,
        role: "listitem",
        draggable: previewing ? null : "true",
        "data-animation-id": id,
        "data-effect": animation.effect,
        "data-trigger": animation.trigger,
        "aria-current": id === selected ? "true" : "false"
      }, [
        h("span", { class: "animation-grip", "aria-hidden": "true" }, [icon("grip", { size: 14 })]),
        h("span", { class: "animation-order", text: String(index + 1) }),
        h("span", { class: "animation-trigger" }, [
          icon(TRIGGER_ICONS[animation.trigger], { size: 14 }),
          inlineSelect("trigger", "Start", Object.entries(TRIGGER_LABELS), animation.trigger, (value) => update(id, { trigger: value }))
        ]),
        h("span", { class: "animation-object", text: objectLabel(object) }),
        h("span", { class: "animation-effect" }, [
          inlineSelect("effect", "Effect", Object.entries(EFFECT_LABELS), animation.effect, (value) => update(id, effectPatch(animation, value))),
          animation.effect === "slide-in"
            ? inlineSelect("direction", "Direction", Object.entries(DIRECTION_LABELS), animation.direction ?? "left", (value) => update(id, { direction: value }))
            : null
        ]),
        h("span", { class: "animation-timing" }, [
          inlineMs("delay", "Delay (ms)", animation.delay, (value) => update(id, { delay: value }), render),
          inlineMs("duration", "Duration (ms)", animation.duration, (value) => update(id, { duration: value }), render)
        ]),
        up,
        down,
        remove
      ]);

      row.addEventListener("click", (event) => {
        if (/** @type {Element} */ (event.target).closest("button, input, select")) return;
        api.onSelect(id);
      });
      // Using a field in a row also selects that row.
      row.addEventListener("focusin", () => {
        if (id !== api.getSelectedId()) api.onSelect(id);
      });
      up.addEventListener("click", () => api.onMove(id, index - 1));
      down.addEventListener("click", () => api.onMove(id, index + 1));
      remove.addEventListener("click", () => api.onDelete(id));

      row.addEventListener("dragstart", (event) => {
        dragId = id;
        row.classList.add("is-dragging");
        /** @type {DragEvent} */ (event).dataTransfer?.setData("text/plain", id);
      });
      row.addEventListener("dragend", () => {
        dragId = null;
        row.classList.remove("is-dragging");
        clearDropMarks();
      });
      row.addEventListener("dragover", (event) => {
        if (!dragId) return;
        event.preventDefault();
        clearDropMarks();
        const target = dropTarget(id, /** @type {MouseEvent} */ (event), row);
        if (planSlideReorder(slide.animationOrder, dragId, target)) {
          row.classList.add(target.type === "after" ? "drop-after" : "drop-before");
        }
      });
      row.addEventListener("drop", (event) => {
        if (!dragId) return;
        event.preventDefault();
        const dragged = dragId;
        const target = dropTarget(id, /** @type {MouseEvent} */ (event), row);
        dragId = null;
        clearDropMarks();
        const plan = planSlideReorder(slide.animationOrder, dragged, target);
        if (plan) api.onMove(dragged, plan.index);
      });

      list.append(row);
    });
    element.append(list);
    element.scrollTop = scrollTop;
    if (focus) {
      const target = /** @type {HTMLElement | null} */ (
        list.querySelector(`[data-animation-id="${focus.id}"] [data-field="${focus.field}"]`)
      );
      target?.focus();
    }
  }

  element.addEventListener("keydown", (event) => {
    // Typing in a row's field must not delete the animation.
    if (/** @type {Element} */ (event.target).closest("input, select")) return;
    const key = /** @type {KeyboardEvent} */ (event).key;
    const selected = api.getSelectedId();
    if (!selected) return;
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      api.onDelete(selected);
    }
  });

  return { element, render, select };
}
