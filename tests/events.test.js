import { describe, expect, it } from "vitest";
import { Emitter } from "../src/core/events.js";

describe("Emitter", () => {
  it("delivers payloads to subscribers", () => {
    const emitter = new Emitter();
    /** @type {string[]} */
    const seen = [];
    emitter.on("e", (p) => seen.push(/** @type {string} */ (p)));
    emitter.emit("e", "a");
    emitter.emit("e", "b");
    expect(seen).toEqual(["a", "b"]);
  });

  it("unsubscribes via the returned function", () => {
    const emitter = new Emitter();
    let called = 0;
    const off = emitter.on("e", () => called++);
    emitter.emit("e");
    off();
    emitter.emit("e");
    expect(called).toBe(1);
  });

  it("isolates listener errors without breaking other listeners", () => {
    const emitter = new Emitter();
    let second = false;
    emitter.on("e", () => {
      throw new Error("boom");
    });
    emitter.on("e", () => {
      second = true;
    });
    expect(() => emitter.emit("e")).not.toThrow();
    expect(second).toBe(true);
  });

  it("does not deliver to other events", () => {
    const emitter = new Emitter();
    let called = 0;
    emitter.on("a", () => called++);
    emitter.emit("b");
    expect(called).toBe(0);
  });
});
