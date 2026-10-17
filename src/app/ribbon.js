/**
 * Ribbon renderer: a tab strip plus a panel of labelled groups.
 *
 * Structure comes from `ribbon-tabs.js`; this module only renders it, wires the
 * controls to a live context, and keeps `enabled` / `active` state fresh via
 * `update()`. Buttons never take focus or selection from the editor underneath
 * (mousedown is cancelled), which is what lets "Bold" act on the current selection.
 */

import { clear, h } from "./dom.js";
import { icon } from "./icons.js";
import { buildMenu, createPopoverHost } from "./popover.js";
import { defaultTabId, getTabs } from "./ribbon-tabs.js";

/** @typedef {import("./ribbon-tabs.js").Control} Control */
/** @typedef {import("./ribbon-tabs.js").RibbonContext} RibbonContext */

/**
 * @typedef {object} RibbonHandle
 * @property {HTMLElement} element
 * @property {(pageType: string | null | undefined) => void} setPage
 * @property {() => void} update
 * @property {() => string} getActiveTab
 * @property {(tabId: string) => void} selectTab
 * @property {() => void} destroy
 */

/**
 * @param {() => RibbonContext} getContext Fresh context on every call.
 * @param {{ onTabChange?: (tabId: string) => void }} [options] `onTabChange` fires when the
 *   user picks a tab (not when `setPage` swaps the tab set).
 * @returns {RibbonHandle}
 */
export function createRibbon(getContext, options = {}) {
  const element = h("div", { class: "ribbon" });
  const tabStrip = h("div", { class: "ribbon-tabs", role: "tablist" });
  const panel = h("div", { class: "ribbon-panel", role: "tabpanel" });
  element.append(tabStrip, panel);
  const popovers = createPopoverHost(element);

  /** @type {string | null | undefined} */
  let pageType = null;
  /** Last active tab per page type (and "none" when no page is open). */
  const rememberedTab = new Map();
  /** @type {{ control: Control, element: HTMLElement, input?: HTMLInputElement }[]} */
  let records = [];

  // Keep the editor selection when a ribbon button is pressed.
  element.addEventListener("mousedown", (event) => {
    if (/** @type {HTMLElement} */ (event.target).closest("button")) event.preventDefault();
  });

  const typeKey = () => pageType ?? "none";

  function activeTabId() {
    const tabs = getTabs(pageType);
    const wanted = rememberedTab.get(typeKey()) ?? defaultTabId(pageType);
    return tabs.some((tab) => tab.id === wanted) ? wanted : defaultTabId(pageType);
  }

  // -- control rendering ----------------------------------------------------------

  /**
   * @param {Control} control
   * @returns {{ wrap: HTMLElement, element: HTMLElement, input?: HTMLInputElement }}
   *   `wrap` is what is laid out in the group; `element` is the interactive part.
   */
  function renderControl(control) {
    const size = control.size ?? "large";
    const attrs = { "data-action": control.id, ...(control.attrs ?? {}) };

    if (control.kind === "select") {
      const select = /** @type {HTMLSelectElement} */ (
        h("select", { class: "ribbon-select", "aria-label": control.title ?? control.label, "data-control": control.id })
      );
      for (const [name, value] of Object.entries(attrs)) select.setAttribute(name, String(value));
      for (const option of control.options ?? []) {
        select.append(h("option", { value: option.value, text: option.label }));
      }
      select.addEventListener("change", () => {
        control.onSelect?.(getContext(), select.value);
        update();
      });
      const wrap = h("label", { class: "ribbon-control ribbon-select-wrap" }, [
        control.icon ? icon(control.icon, { size: 22 }) : null,
        select,
        h("span", { class: "ribbon-label", text: control.label })
      ]);
      return { wrap, element: select };
    }

    if (control.kind === "color") {
      const input = /** @type {HTMLInputElement} */ (
        h("input", { class: "ribbon-color-input", type: "color", "aria-label": control.title ?? control.label, "data-role": control.id })
      );
      for (const [name, value] of Object.entries(attrs)) input.setAttribute(name, String(value));
      input.addEventListener("change", () => {
        control.onSelect?.(getContext(), input.value);
        update();
      });
      const wrap = h("label", { class: "ribbon-control ribbon-color-wrap" }, [
        control.icon ? icon(control.icon, { size: 22 }) : null,
        input,
        h("span", { class: "ribbon-label", text: control.label })
      ]);
      return { wrap, element: input };
    }

    if (control.kind === "field") {
      const input = /** @type {HTMLInputElement} */ (
        h("input", {
          class: "ribbon-field-input",
          type: "number",
          min: control.min,
          "aria-label": control.label,
          "data-role": control.id
        })
      );
      for (const [name, value] of Object.entries(attrs)) input.setAttribute(name, String(value));
      // Applies as the value is committed (Enter, or leaving the field): no button.
      const run = () => {
        const value = Number(input.value);
        if (input.value.trim() === "" || !Number.isFinite(value)) return;
        control.apply?.(getContext(), value);
        update();
      };
      input.addEventListener("change", run);
      input.addEventListener("keydown", (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        if (key === "Enter") {
          event.preventDefault();
          run();
        } else if (key === "Escape") {
          input.value = String(control.value?.(getContext()) ?? "");
          input.blur();
        }
      });
      const wrap = h("div", { class: "ribbon-control ribbon-field" }, [
        h("span", { class: "ribbon-field-label" }, [
          control.icon ? icon(control.icon, { size: 16 }) : null,
          h("span", { text: control.label })
        ]),
        h("span", { class: "ribbon-field-row" }, [input])
      ]);
      return { wrap, element: input };
    }

    const button = h("button", {
      class: `ribbon-button size-${size} kind-${control.kind}`,
      type: "button",
      "data-control": control.id,
      "aria-label": control.title ?? control.label
    });
    for (const [name, value] of Object.entries(attrs)) button.setAttribute(name, String(value));
    if (control.icon) button.append(h("span", { class: "ribbon-icon" }, [icon(control.icon, { size: size === "large" ? 22 : 18 })]));
    if (size === "large") button.append(h("span", { class: "ribbon-label", text: control.label }));
    if (control.kind === "menu") button.setAttribute("aria-haspopup", "true");

    button.addEventListener("click", () => {
      if (/** @type {HTMLButtonElement} */ (button).disabled) return;
      const ctx = getContext();
      if (control.kind === "menu") {
        openMenu(control, button, ctx);
        return;
      }
      popovers.close();
      control.action?.(ctx, button);
      update();
    });
    return { wrap: button, element: button };
  }

  /**
   * @param {Control} control
   * @param {HTMLElement} anchor
   * @param {RibbonContext} ctx
   */
  function openMenu(control, anchor, ctx) {
    const close = () => popovers.close();
    const body = control.items
      ? buildMenu(control.items(ctx), close, (name) => icon(name, { size: 16 }))
      : control.content?.(ctx, close);
    if (!body) return;
    popovers.show(anchor, body, { keepFocus: control.keepFocus });
  }

  // -- tabs / panel -------------------------------------------------------------------

  function renderTabs() {
    clear(tabStrip);
    const active = activeTabId();
    for (const tab of getTabs(pageType)) {
      const button = h("button", {
        class: `ribbon-tab${tab.id === active ? " is-active" : ""}${tab.id === "file" ? " is-file" : ""}`,
        type: "button",
        role: "tab",
        "aria-selected": tab.id === active ? "true" : "false",
        "data-tab": tab.id,
        text: tab.label
      });
      button.addEventListener("click", () => selectTab(tab.id));
      tabStrip.append(button);
    }
  }

  function renderPanel() {
    clear(panel);
    records = [];
    const active = activeTabId();
    const tab = getTabs(pageType).find((candidate) => candidate.id === active);
    if (!tab) return;
    panel.setAttribute("data-tab", tab.id);

    for (const group of tab.groups) {
      const body = h("div", { class: "ribbon-group-controls" });
      for (const control of group.controls) {
        const rendered = renderControl(control);
        body.append(rendered.wrap);
        records.push({ control, element: rendered.element, input: rendered.input });
      }
      panel.append(
        h("div", { class: "ribbon-group", "data-group": group.id }, [
          body,
          h("div", { class: "ribbon-group-label", text: group.label })
        ])
      );
    }
  }

  /** @param {string} tabId */
  function selectTab(tabId) {
    popovers.close();
    rememberedTab.set(typeKey(), tabId);
    renderTabs();
    renderPanel();
    update();
    options.onTabChange?.(tabId);
  }

  function update() {
    const ctx = getContext();
    for (const record of records) {
      const { control, element: target, input } = record;
      const enabled = control.enabled ? control.enabled(ctx) : true;
      const title = control.title ?? control.label;

      if (control.kind === "select") {
        const select = /** @type {HTMLSelectElement} */ (target);
        select.disabled = !enabled;
        if (control.value && document.activeElement !== select) select.value = String(control.value(ctx));
      } else if (control.kind === "color") {
        const picker = /** @type {HTMLInputElement} */ (target);
        picker.disabled = !enabled;
        const value = control.value ? String(control.value(ctx)) : "";
        if (document.activeElement !== picker && /^#[0-9a-f]{6}$/i.test(value)) picker.value = value.toLowerCase();
      } else if (control.kind === "field") {
        const field = /** @type {HTMLInputElement} */ (target);
        field.disabled = !enabled;
        if (control.value && document.activeElement !== field) field.value = String(control.value(ctx));
      } else {
        /** @type {HTMLButtonElement} */ (target).disabled = !enabled;
        if (control.active) {
          const active = Boolean(control.active(ctx));
          target.classList.toggle("is-active", active);
          target.setAttribute("aria-pressed", active ? "true" : "false");
        }
      }

      const tip = enabled ? title : (control.disabledReason ?? title);
      target.setAttribute("title", tip);
      if (input) input.setAttribute("title", tip);
      target.classList.toggle("is-disabled", !enabled);
      if (!enabled && control.disabledReason) target.setAttribute("data-disabled-reason", control.disabledReason);
      else target.removeAttribute("data-disabled-reason");
    }
  }

  /** @param {string | null | undefined} type */
  function setPage(type) {
    popovers.close();
    pageType = type ?? null;
    element.setAttribute("data-page-type", pageType ?? "none");
    renderTabs();
    renderPanel();
    update();
  }

  setPage(null);

  return {
    element,
    setPage,
    update,
    getActiveTab: activeTabId,
    selectTab,
    destroy: () => popovers.destroy()
  };
}
