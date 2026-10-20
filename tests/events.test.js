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

describe("Emitter hardening", () => {
  it("skips a listener unsubscribed by an earlier listener of the same emit", () => {
    const emitter = new Emitter();
    const calls = [];
    let offSecond = () => {};
    emitter.on("e", () => {
      calls.push("first");
      offSecond();
    });
    offSecond = emitter.on("e", () => calls.push("second"));
    emitter.emit("e");
    expect(calls).toEqual(["first"]);
  });

  it("routes listener errors to onError", () => {
    const seen = [];
    const emitter = new Emitter({ onError: (error, event) => seen.push([error.message, event]) });
    emitter.on("e", () => {
      throw new Error("boom");
    });
    emitter.emit("e");
    expect(seen).toEqual([["boom", "e"]]);
  });

  it("strict mode rethrows after every listener ran", () => {
    const emitter = new Emitter({ strict: true, onError: () => {} });
    let ran = false;
    emitter.on("e", () => {
      throw new Error("boom");
    });
    emitter.on("e", () => {
      ran = true;
    });
    expect(() => emitter.emit("e")).toThrow("boom");
    expect(ran).toBe(true);
  });
});
