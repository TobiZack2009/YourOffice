import { afterEach, describe, expect, it } from "vitest";
import { buildMenu, createPopoverHost } from "../src/app/popover.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createPopoverHost.showAt", () => {
  it("opens a popover at a point with its own class, and closes on Escape", () => {
    const host = createPopoverHost(document.body);
    const body = document.createElement("div");
    body.textContent = "hello";
    const popover = host.showAt({ x: 30, y: 50 }, body, { class: "context-menu" });
    expect(popover.classList.contains("context-menu")).toBe(true);
    expect(popover.style.left).toBe("30px");
    expect(popover.style.top).toBe("50px");
    expect(host.isOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.isOpen()).toBe(false);
    expect(document.body.querySelector(".popover")).toBeNull();
  });

  it("replaces an open popover and closes on an outside press", () => {
    const host = createPopoverHost(document.body);
    host.showAt({ x: 10, y: 10 }, document.createElement("div"));
    host.showAt({ x: 20, y: 20 }, document.createElement("div"));
    expect(document.body.querySelectorAll(".popover")).toHaveLength(1);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(host.isOpen()).toBe(false);
  });

  it("closes the popover when a menu item is chosen, then runs its action", () => {
    const host = createPopoverHost(document.body);
    let ran = false;
    host.showAt(
      { x: 0, y: 0 },
      buildMenu([{ label: "Go", attrs: { "data-action": "go" }, action: () => (ran = !host.isOpen()) }], host.close)
    );
    /** @type {HTMLElement} */ (document.body.querySelector('[data-action="go"]')).click();
    expect(ran).toBe(true);
  });
});

describe("buildMenu submenus", () => {
  const build = (/** @type {() => void} */ close, action = () => {}) =>
    buildMenu(
      [
        {
          label: "Insert",
          attrs: { "data-action": "insert-menu" },
          submenu: [{ label: "Row", attrs: { "data-action": "row" }, action }]
        },
        { label: "Delete", submenu: [{ label: "Column", attrs: { "data-action": "col" } }] }
      ],
      close
    );

  it("shows only the section name until hovered", () => {
    const menu = build(() => {});
    document.body.append(menu);
    const sections = menu.querySelectorAll(".menu-submenu");
    expect(sections).toHaveLength(2);
    expect(sections[0].classList.contains("is-open")).toBe(false);
    expect(menu.querySelector(".menu-submenu-trigger")?.textContent).toContain("Insert");

    sections[0].dispatchEvent(new MouseEvent("mouseenter"));
    expect(sections[0].classList.contains("is-open")).toBe(true);
    sections[1].dispatchEvent(new MouseEvent("mouseenter"));
    expect(sections[0].classList.contains("is-open")).toBe(false);
    expect(sections[1].classList.contains("is-open")).toBe(true);
    sections[1].dispatchEvent(new MouseEvent("mouseleave"));
    expect(sections[1].classList.contains("is-open")).toBe(false);
  });

  it("does not run an action for the section row, only for its options", () => {
    let calls = 0;
    let closed = 0;
    const menu = build(() => closed++, () => calls++);
    /** @type {HTMLElement} */ (menu.querySelector('[data-action="insert-menu"]')).click();
    expect(calls).toBe(0);
    expect(closed).toBe(0);
    /** @type {HTMLElement} */ (menu.querySelector('[data-action="row"]')).click();
    expect(calls).toBe(1);
    expect(closed).toBe(1);
  });
});
