/**
 * Inspector: the right pane of the presentation editor.
 *
 * It shows exact values for the selection (position and size, fill, stroke, text,
 * arrange, link) or, with nothing selected, for the slide (background, transition,
 * size). It owns no state: every value is read from the editor handle (`api`) and
 * every edit goes back through it, so the same commands back the ribbon.
 *
 * The field set is rebuilt only when the *kind* of selection changes; otherwise
 * `render()` just syncs values into the existing inputs, which keeps focus and Tab
 * order intact while the user edits a number.
 */

import { SIZE_PRESETS } from "../presentation/geometry.js";
import { SIZE_LIMITS, TRANSITION_DIRECTIONS, TRANSITION_STYLES, VALIGNS } from "../presentation/model.js";
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";

/** @typedef {import("../presentation/model.js").SlideObject} SlideObject */

/**
 * `<input type=color>` only accepts #rrggbb.
 * @param {string | null | undefined} color
 * @param {string} [fallback]
 */
export function toColorInput(color, fallback = "#000000") {
  if (typeof color !== "string") return fallback;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/i.exec(color);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color);
  return long ? `#${long[1]}`.toLowerCase() : fallback;
}

const supportsFill = (/** @type {SlideObject} */ o) => o.type === "shape" || o.type === "text";
const supportsStroke = (/** @type {SlideObject} */ o) => o.type === "shape" || o.type === "text" || o.type === "line";
const supportsText = (/** @type {SlideObject} */ o) => o.type === "shape" || o.type === "text";

/**
 * @typedef {object} InspectorApi
 * @property {() => SlideObject[]} getSelectedObjects
 * @property {() => import("../presentation/model.js").Slide | null} getSlide
 * @property {() => { width: number, height: number }} getSize
 * @property {() => { x: number, y: number, width: number, height: number } | null} getSelectionBounds
 * @property {(patch: Record<string, number>) => void} setGeometry
 * @property {(color: string | null) => void} setFill
 * @property {(stroke: { color?: string, width?: number } | null) => void} setStroke
 * @property {(style: Record<string, unknown>) => void} setTextStyle
 * @property {(op: "front" | "forward" | "backward" | "back") => void} arrange
 * @property {(link: import("../presentation/model.js").ObjectLink | null) => void} setObjectLink
 * @property {(color: string) => void} setBackground
 * @property {(patch: Record<string, unknown>) => void} setTransition
 * @property {() => void} applyTransitionToAll
 * @property {(width: number, height: number) => void} requestSlideSize
 * @property {() => { id: string, title: string, type: string }[]} listPages
 * @property {() => { id: string, number: number }[]} listSlides
 */

/**
 * @param {InspectorApi} api
 * @returns {{ element: HTMLElement, render: () => void }}
 */
export function createInspector(api) {
  const element = h("aside", { class: "inspector", "data-role": "inspector", "aria-label": "Inspector" });
  /** @type {string | null} */
  let builtKey = null;
  /** @type {(() => void)[]} */
  let syncers = [];
  /** Link kind picked in the UI before a target exists (a link needs a target to be valid). */
  let linkDraft = "";

  // -- field builders ---------------------------------------------------------

  /**
   * @param {string} title
   * @param {Array<Node | null>} rows
   * @param {string} id
   */
  function section(title, rows, id) {
    return h("section", { class: "inspector-section", "data-section": id }, [
      h("h3", { class: "inspector-heading", text: title }),
      ...rows
    ]);
  }

  /**
   * @param {string} label
   * @param {Node[]} controls
   */
  function row(label, controls) {
    return h("label", { class: "inspector-row" }, [h("span", { class: "inspector-label", text: label }), ...controls]);
  }

  /**
   * A number input that applies on change/Enter and reverts on Escape.
   * @param {{ field: string, get: () => number | "" , set: (value: number) => void, min?: number, max?: number, step?: number }} spec
   */
  function numberInput(spec) {
    const input = /** @type {HTMLInputElement} */ (h("input", {
      class: "inspector-input",
      type: "number",
      min: spec.min,
      max: spec.max,
      step: spec.step ?? 1,
      "data-field": spec.field,
      "aria-label": spec.field
    }));
    const sync = () => {
      if (document.activeElement !== input) input.value = String(spec.get());
    };
    const commit = () => {
      const value = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(value)) {
        input.value = String(spec.get());
        return;
      }
      // Enter commits without clearing the browser's pending change, so blur fires
      // it again; skipping unchanged values stops that from re-rendering mid-click.
      if (value === spec.get()) return;
      spec.set(value);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      const key = /** @type {KeyboardEvent} */ (event).key;
      if (key === "Enter") {
        event.preventDefault();
        commit();
      } else if (key === "Escape") {
        input.value = String(spec.get());
        input.blur();
      }
      event.stopPropagation();
    });
    syncers.push(sync);
    return input;
  }

  /**
   * @param {{ field: string, get: () => string | null | undefined, set: (value: string) => void, fallback?: string }} spec
   */
  function colorInput(spec) {
    const input = /** @type {HTMLInputElement} */ (h("input", {
      class: "inspector-color",
      type: "color",
      "data-field": spec.field,
      "aria-label": spec.field
    }));
    input.addEventListener("change", () => spec.set(input.value));
    syncers.push(() => {
      input.value = toColorInput(spec.get(), spec.fallback);
    });
    return input;
  }

  /**
   * @param {{ field: string, options: { value: string, label: string }[], get: () => string, set: (value: string) => void }} spec
   */
  function selectInput(spec) {
    const select = /** @type {HTMLSelectElement} */ (h("select", {
      class: "inspector-select",
      "data-field": spec.field,
      "aria-label": spec.field
    }, spec.options.map((o) => h("option", { value: o.value, text: o.label }))));
    select.addEventListener("change", () => spec.set(select.value));
    syncers.push(() => {
      if (document.activeElement !== select) select.value = spec.get();
    });
    return select;
  }

  /**
   * A checkbox that turns an optional property (fill, stroke) on or off.
   * @param {{ field: string, get: () => boolean, set: (on: boolean) => void }} spec
   */
  function toggleInput(spec) {
    const box = /** @type {HTMLInputElement} */ (h("input", {
      class: "inspector-check",
      type: "checkbox",
      "data-field": spec.field,
      "aria-label": spec.field
    }));
    box.addEventListener("change", () => spec.set(box.checked));
    syncers.push(() => {
      box.checked = spec.get();
    });
    return box;
  }

  /**
   * @param {string} action
   * @param {string} label
   * @param {string} iconName
   * @param {() => void} run
   * @param {() => boolean} [active]
   */
  function iconButton(action, label, iconName, run, active) {
    const button = h("button", {
      class: "inspector-button",
      type: "button",
      "data-action": action,
      title: label,
      "aria-label": label
    }, [icon(iconName, { size: 16 })]);
    button.addEventListener("click", run);
    if (active) {
      syncers.push(() => {
        const on = active();
        button.classList.toggle("is-active", on);
        button.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    return button;
  }

  // -- sections ---------------------------------------------------------------

  const selected = () => api.getSelectedObjects();
  const primary = () => api.getSelectedObjects()[0];
  /** @param {(o: SlideObject) => boolean} test */
  const firstWith = (test) => selected().find(test);

  /** @param {boolean} single */
  function positionSection(single) {
    const bounds = () => api.getSelectionBounds();
    /** @param {string} key */
    const geometry = (key) => () => {
      const o = primary();
      if (!o) return "";
      if (single) return Number(/** @type {any} */ (o)[key] ?? 0);
      const b = bounds();
      return b ? Number(/** @type {any} */ (b)[key]) : "";
    };
    /** @param {string} key */
    const setter = (key) => (/** @type {number} */ value) => api.setGeometry({ [key]: value });
    const rows = [
      row("X", [numberInput({ field: "x", get: geometry("x"), set: setter("x") })]),
      row("Y", [numberInput({ field: "y", get: geometry("y"), set: setter("y") })])
    ];
    if (single) {
      rows.push(
        row("Width", [numberInput({ field: "width", get: geometry("width"), set: setter("width"), min: 0 })]),
        row("Height", [numberInput({ field: "height", get: geometry("height"), set: setter("height"), min: 0 })]),
        row("Rotation", [numberInput({ field: "rotation", get: () => Number(primary()?.rotation ?? 0), set: setter("rotation"), step: 5 })])
      );
    }
    return section("Position and size", rows, "position");
  }

  function fillSection() {
    return section("Fill", [
      row("Fill", [
        toggleInput({ field: "fill-enabled", get: () => Boolean(firstWith(supportsFill)?.fill), set: (on) => api.setFill(on ? (firstWith(supportsFill)?.fill ?? "#e6f0ff") : null) }),
        colorInput({ field: "fill", get: () => firstWith(supportsFill)?.fill, set: (color) => api.setFill(color), fallback: "#e6f0ff" })
      ])
    ], "fill");
  }

  function strokeSection() {
    return section("Stroke", [
      row("Stroke", [
        toggleInput({ field: "stroke-enabled", get: () => Boolean(firstWith(supportsStroke)?.stroke), set: (on) => api.setStroke(on ? {} : null) }),
        colorInput({ field: "stroke", get: () => firstWith(supportsStroke)?.stroke?.color, set: (color) => api.setStroke({ color }), fallback: "#1d6fdc" })
      ]),
      row("Width", [
        numberInput({ field: "stroke-width", get: () => firstWith(supportsStroke)?.stroke?.width ?? "", set: (width) => api.setStroke({ width }), min: 0, max: 100 })
      ])
    ], "stroke");
  }

  function textSection() {
    const body = () => firstWith(supportsText)?.text;
    return section("Text", [
      row("Size", [numberInput({ field: "font-size", get: () => body()?.fontSize ?? "", set: (fontSize) => api.setTextStyle({ fontSize }), min: 4, max: 600 })]),
      row("Colour", [colorInput({ field: "text-color", get: () => body()?.color, set: (color) => api.setTextStyle({ color }), fallback: "#1d1d1f" })]),
      row("Align", [
        h("span", { class: "inspector-buttons" }, ["left", "center", "right"].map((align) =>
          iconButton(`align-${align}`, `Align ${align}`, `align-${align}`, () => api.setTextStyle({ align }), () => (body()?.align ?? "left") === align)
        ))
      ]),
      row("Vertical", [
        selectInput({
          field: "valign",
          options: VALIGNS.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
          get: () => body()?.valign ?? "top",
          set: (valign) => api.setTextStyle({ valign })
        })
      ])
    ], "text");
  }

  function arrangeSection() {
    return section("Arrange", [
      h("div", { class: "inspector-buttons" }, [
        iconButton("arrange-front", "Bring to front", "bring-front", () => api.arrange("front")),
        iconButton("arrange-forward", "Bring forward", "bring-forward", () => api.arrange("forward")),
        iconButton("arrange-backward", "Send backward", "send-backward", () => api.arrange("backward")),
        iconButton("arrange-back", "Send to back", "send-back", () => api.arrange("back"))
      ])
    ], "arrange");
  }

  function linkSection() {
    const kindOf = () => linkDraft || primary()?.link?.kind || "";
    const kind = selectInput({
      field: "link-kind",
      options: [
        { value: "", label: "None" },
        { value: "url", label: "Web address" },
        { value: "page", label: "Page" },
        { value: "slide", label: "Slide" }
      ],
      get: kindOf,
      set: (value) => {
        linkDraft = value;
        if (!value) {
          linkDraft = "";
          api.setObjectLink(null);
        } else if (value === "page") {
          const first = api.listPages()[0];
          if (first) api.setObjectLink({ kind: "page", pageId: first.id });
        } else if (value === "slide") {
          const first = api.listSlides()[0];
          if (first) api.setObjectLink({ kind: "slide", slideId: first.id });
        }
        render();
      }
    });

    const url = /** @type {HTMLInputElement} */ (h("input", {
      class: "inspector-input inspector-url",
      type: "url",
      placeholder: "https://…",
      "data-field": "link-url",
      "aria-label": "Link address"
    }));
    const commitUrl = () => {
      const value = url.value.trim();
      if (!value) return;
      linkDraft = "";
      api.setObjectLink({ kind: "url", url: value });
    };
    url.addEventListener("change", commitUrl);
    url.addEventListener("keydown", (event) => {
      if (/** @type {KeyboardEvent} */ (event).key === "Enter") {
        event.preventDefault();
        commitUrl();
      }
      event.stopPropagation();
    });

    const page = selectInput({
      field: "link-page",
      options: api.listPages().map((p) => ({ value: p.id, label: p.title || "Untitled" })),
      get: () => {
        const link = primary()?.link;
        return link?.kind === "page" ? link.pageId : "";
      },
      set: (pageId) => api.setObjectLink({ kind: "page", pageId })
    });
    const slide = selectInput({
      field: "link-slide",
      options: api.listSlides().map((s) => ({ value: s.id, label: `Slide ${s.number}` })),
      get: () => {
        const link = primary()?.link;
        return link?.kind === "slide" ? link.slideId : "";
      },
      set: (slideId) => api.setObjectLink({ kind: "slide", slideId })
    });

    const targets = h("div", { class: "inspector-row inspector-link-target" }, [url, page, slide]);
    syncers.push(() => {
      const current = kindOf();
      url.hidden = current !== "url";
      page.hidden = current !== "page";
      slide.hidden = current !== "slide";
      targets.hidden = !current;
      const link = primary()?.link;
      if (document.activeElement !== url) url.value = link?.kind === "url" ? link.url : "";
    });
    return section("Link", [row("Link to", [kind]), targets], "link");
  }

  function slideSections() {
    const transition = () => api.getSlide()?.transition ?? { style: "none", direction: "left", duration: 500 };
    const width = /** @type {HTMLInputElement} */ (numberInput({ field: "slide-width", get: () => api.getSize().width, set: () => {}, min: SIZE_LIMITS.min, max: SIZE_LIMITS.max }));
    const height = /** @type {HTMLInputElement} */ (numberInput({ field: "slide-height", get: () => api.getSize().height, set: () => {}, min: SIZE_LIMITS.min, max: SIZE_LIMITS.max }));
    // Width/Height only apply together, through the Apply button (which asks Scale or Keep).
    const apply = h("button", { class: "inspector-apply", type: "button", "data-action": "apply-size", text: "Apply" });
    apply.addEventListener("click", () => api.requestSlideSize(Number(width.value), Number(height.value)));
    const preset = selectInput({
      field: "size-preset",
      options: [...SIZE_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: "custom", label: "Custom" }],
      get: () => {
        const s = api.getSize();
        return SIZE_PRESETS.find((p) => p.width === s.width && p.height === s.height)?.id ?? "custom";
      },
      set: (id) => {
        const chosen = SIZE_PRESETS.find((p) => p.id === id);
        if (chosen) {
          width.value = String(chosen.width);
          height.value = String(chosen.height);
          api.requestSlideSize(chosen.width, chosen.height);
        }
      }
    });
    return [
      section("Background", [
        row("Colour", [colorInput({ field: "background", get: () => api.getSlide()?.background.color, set: (color) => api.setBackground(color), fallback: "#ffffff" })])
      ], "background"),
      section("Transition", [
        row("Style", [selectInput({
          field: "transition-style",
          options: TRANSITION_STYLES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })),
          get: () => transition().style,
          set: (style) => api.setTransition({ style })
        })]),
        row("Direction", [selectInput({
          field: "transition-direction",
          options: TRANSITION_DIRECTIONS.map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) })),
          get: () => transition().direction,
          set: (direction) => api.setTransition({ direction })
        })]),
        row("Duration (ms)", [numberInput({
          field: "transition-duration",
          get: () => transition().duration,
          set: (duration) => api.setTransition({ duration: Math.min(10000, Math.max(0, Math.round(duration))) }),
          min: 0,
          max: 10000,
          step: 50
        })]),
        (() => {
          const all = h("button", { class: "inspector-apply", type: "button", "data-action": "apply-transition-all", text: "Apply to all slides" });
          all.addEventListener("click", () => api.applyTransitionToAll());
          return all;
        })()
      ], "transition"),
      section("Slide size", [
        row("Preset", [preset]),
        row("Width", [width]),
        row("Height", [height]),
        apply
      ], "size")
    ];
  }

  // -- build / render ---------------------------------------------------------

  function selectionKey() {
    const objects = selected();
    if (objects.length === 0) return "slide";
    const caps = [
      objects.some(supportsFill) ? "f" : "",
      objects.some(supportsStroke) ? "s" : "",
      objects.some(supportsText) ? "t" : ""
    ].join("");
    return objects.length > 1 ? `multi:${caps}` : `single:${objects[0].type}:${caps}`;
  }

  /** @param {string} key */
  function build(key) {
    clear(element);
    syncers = [];
    builtKey = key;
    if (key === "slide") {
      element.append(h("h2", { class: "inspector-title", text: "Slide" }), ...slideSections());
      return;
    }
    const objects = selected();
    const single = objects.length === 1;
    element.append(h("h2", { class: "inspector-title", text: single ? ({ text: "Text box", shape: "Shape", line: "Line", image: "Image" }[objects[0].type] ?? "Object") : `${objects.length} objects` }));
    element.append(positionSection(single));
    if (objects.some(supportsFill)) element.append(fillSection());
    if (objects.some(supportsStroke)) element.append(strokeSection());
    if (objects.some(supportsText)) element.append(textSection());
    element.append(arrangeSection());
    if (single) element.append(linkSection());
  }

  function render() {
    const key = selectionKey();
    if (key !== builtKey) {
      linkDraft = "";
      build(key);
    }
    for (const sync of syncers) sync();
  }

  render();
  return { element, render };
}
