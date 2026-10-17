/**
 * Shared popover + menu helpers.
 *
 * One host per owner (ribbon, sidebar, ...). A host shows at most one popover,
 * positioned under an anchor element with `position: fixed`, and closes it on
 * Escape, on an outside press, or when the same anchor is pressed again.
 * Buttons inside a popover do not steal focus from the editor underneath.
 */

import { h } from "./dom.js";

/**
 * @typedef {object} PopoverHost
 * @property {(anchor: HTMLElement, content: HTMLElement, options?: { keepFocus?: boolean, class?: string }) => HTMLElement | null} show
 *   Opens the popover, or closes it and returns null when this anchor already owns it.
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {() => void} destroy
 */

/**
 * @param {HTMLElement} container Element the popover is appended to.
 * @returns {PopoverHost}
 */
export function createPopoverHost(container) {
  /** @type {HTMLElement | null} */
  let popover = null;
  /** @type {HTMLElement | null} */
  let anchorElement = null;

  /** @param {Event} event */
  function onOutsidePress(event) {
    const target = /** @type {Node} */ (event.target);
    if (popover?.contains(target) || anchorElement?.contains(target)) return;
    close();
  }

  /** @param {Event} event */
  function onKeydown(event) {
    if (/** @type {KeyboardEvent} */ (event).key === "Escape") close();
  }

  function close() {
    if (!popover) return;
    popover.remove();
    popover = null;
    anchorElement = null;
    document.removeEventListener("mousedown", onOutsidePress, true);
    document.removeEventListener("keydown", onKeydown, true);
  }

  return {
    show(anchor, content, options = {}) {
      const toggledOff = popover !== null && anchorElement === anchor;
      close();
      if (toggledOff) return null;

      const element = h("div", { class: `popover${options.class ? ` ${options.class}` : ""}`, role: "dialog" }, [
        content
      ]);
      // Pressing a button inside the popover must not move focus or selection.
      element.addEventListener("mousedown", (event) => {
        if (/** @type {HTMLElement} */ (event.target).closest("button")) event.preventDefault();
      });
      container.append(element);

      const rect = anchor.getBoundingClientRect();
      const width = element.offsetWidth || 0;
      const maxLeft = Math.max(0, (window.innerWidth || 0) - width - 8);
      const left = Math.max(8, maxLeft > 0 ? Math.min(rect.left, maxLeft) : rect.left);
      element.style.left = `${left}px`;
      element.style.top = `${rect.bottom + 4}px`;

      popover = element;
      anchorElement = anchor;
      document.addEventListener("mousedown", onOutsidePress, true);
      document.addEventListener("keydown", onKeydown, true);

      if (options.keepFocus) {
        /** @type {HTMLInputElement | null} */ (element.querySelector("input"))?.focus();
      }
      return element;
    },
    close,
    isOpen: () => popover !== null,
    destroy: close
  };
}

/**
 * @typedef {object} MenuItem
 * @property {string} [label]
 * @property {string} [icon] Icon name (see icons.js).
 * @property {() => void} [action]
 * @property {Record<string, string>} [attrs] Extra attributes, e.g. `data-action`.
 * @property {string} [className]
 * @property {boolean} [danger]
 * @property {boolean} [disabled]
 * @property {boolean} [separator] Renders a divider instead of an item.
 * @property {string} [heading] Renders a small section heading instead of an item.
 */

/**
 * Build a menu body. Each item closes the popover before running its action, so
 * actions that re-render their owner never leave a stale popover behind.
 * @param {MenuItem[]} items
 * @param {() => void} close
 * @param {(name: string) => Element} [makeIcon]
 * @returns {HTMLElement}
 */
export function buildMenu(items, close, makeIcon) {
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if (item.separator) {
      menu.append(h("div", { class: "menu-separator", role: "separator" }));
      continue;
    }
    if (item.heading) {
      menu.append(h("div", { class: "menu-label", text: item.heading }));
      continue;
    }
    const button = h("button", {
      class: `menu-item${item.danger ? " is-danger" : ""}${item.className ? ` ${item.className}` : ""}`,
      type: "button",
      role: "menuitem",
      disabled: item.disabled
    });
    if (item.icon && makeIcon) button.append(makeIcon(item.icon));
    button.append(h("span", { class: "menu-item-label", text: item.label ?? "" }));
    for (const [name, value] of Object.entries(item.attrs ?? {})) button.setAttribute(name, value);
    button.addEventListener("click", () => {
      close();
      item.action?.();
    });
    menu.append(button);
  }
  return menu;
}
