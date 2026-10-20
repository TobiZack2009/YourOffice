// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeyboard } from "../src/app/keyboard.js";

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup() {
  const keyboard = createKeyboard(document);
  cleanups.push(() => keyboard.destroy());
  return keyboard;
}

/** @param {string} key @param {KeyboardEventInit} [init] */
function press(key, init = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

describe("keyboard dispatcher", () => {
  it("runs a shortcut for Cmd or Ctrl and prevents the default", () => {
    const keyboard = setup();
    const run = vi.fn();
    keyboard.define([{ keys: "mod+k", run }]);
    expect(press("k", { metaKey: true }).defaultPrevented).toBe(true);
    press("k", { ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("ignores keys without the modifier and chords with the wrong shift or alt", () => {
    const keyboard = setup();
    const run = vi.fn();
    keyboard.define([{ keys: "mod+z", run }]);
    press("z");
    press("z", { metaKey: true, shiftKey: true });
    press("z", { metaKey: true, altKey: true });
    expect(run).not.toHaveBeenCalled();
    press("z", { metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("accepts alternatives and upper-case event keys", () => {
    const keyboard = setup();
    const run = vi.fn();
    keyboard.define([{ keys: "mod+shift+z|mod+y", run }]);
    press("Z", { metaKey: true, shiftKey: true });
    press("y", { ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves the event alone when `when` refuses", () => {
    const keyboard = setup();
    const run = vi.fn();
    keyboard.define([{ keys: "mod+z", when: () => false, run }]);
    const event = press("z", { metaKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("removes shortcuts with the function define returns", () => {
    const keyboard = setup();
    const run = vi.fn();
    const remove = keyboard.define([{ keys: "mod+k", run }]);
    remove();
    press("k", { metaKey: true });
    expect(run).not.toHaveBeenCalled();
  });

  it("looks in the top scope first, then falls through to those beneath", () => {
    const keyboard = setup();
    const global = vi.fn();
    const grid = vi.fn();
    keyboard.define([
      { keys: "mod+k", run: global },
      { keys: "mod+s", run: global },
      { keys: "mod+k", scope: "grid", run: grid }
    ]);
    const pop = keyboard.push("grid");
    expect(keyboard.scopes()).toEqual(["global", "grid"]);
    press("k", { metaKey: true });
    expect(grid).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
    press("s", { metaKey: true });
    expect(global).toHaveBeenCalledTimes(1);
    pop();
    expect(keyboard.scopes()).toEqual(["global"]);
    press("k", { metaKey: true });
    expect(global).toHaveBeenCalledTimes(2);
  });

  it("hides every scope beneath a modal one", () => {
    const keyboard = setup();
    const global = vi.fn();
    const show = vi.fn();
    keyboard.define([
      { keys: "mod+k", run: global },
      { keys: "mod+enter", scope: "show", run: show }
    ]);
    const pop = keyboard.push("show", { modal: true });
    press("k", { metaKey: true });
    expect(global).not.toHaveBeenCalled();
    press("Enter", { metaKey: true });
    expect(show).toHaveBeenCalledTimes(1);
    pop();
    press("k", { metaKey: true });
    expect(global).toHaveBeenCalledTimes(1);
  });

  it("pop is idempotent and never removes the global scope", () => {
    const keyboard = setup();
    const pop = keyboard.push("grid");
    pop();
    pop();
    expect(keyboard.scopes()).toEqual(["global"]);
  });

  it("stops listening after destroy", () => {
    const keyboard = createKeyboard(document);
    const run = vi.fn();
    keyboard.define([{ keys: "mod+k", run }]);
    keyboard.destroy();
    press("k", { metaKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});
