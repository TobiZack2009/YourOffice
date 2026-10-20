// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { reconcileChildren } from "../src/core/reconcile.js";

const make = (/** @type {string[]} */ names) => names.map((name) => Object.assign(document.createElement("div"), { id: name }));
const names = (/** @type {Element} */ parent) => [...parent.children].map((child) => child.id);

describe("reconcileChildren", () => {
  it("fills an empty parent and empties a full one", () => {
    const parent = document.createElement("div");
    const nodes = make(["a", "b", "c"]);
    reconcileChildren(parent, nodes);
    expect(names(parent)).toEqual(["a", "b", "c"]);
    reconcileChildren(parent, []);
    expect(parent.childNodes).toHaveLength(0);
  });

  it("does not touch nodes that are already in place", () => {
    const parent = document.createElement("div");
    const [a, b, c, d] = make(["a", "b", "c", "d"]);
    reconcileChildren(parent, [a, b, c]);
    const moves = [];
    const observer = new MutationObserver((records) => moves.push(...records));
    observer.observe(parent, { childList: true });
    reconcileChildren(parent, [b, c, d]);
    expect(names(parent)).toEqual(["b", "c", "d"]);
    const removed = observer.takeRecords().concat(moves).flatMap((record) => [...record.removedNodes]);
    expect(removed).toEqual([a]);
  });

  it("reorders and replaces", () => {
    const parent = document.createElement("div");
    const [a, b, c] = make(["a", "b", "c"]);
    const [x] = make(["x"]);
    reconcileChildren(parent, [a, b, c]);
    reconcileChildren(parent, [c, x, a]);
    expect(names(parent)).toEqual(["c", "x", "a"]);
    expect(c.parentNode).toBe(parent);
  });

  it("keeps focus on a node that stays when others around it change", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const [a, b, c] = make(["a", "b", "c"]);
    b.tabIndex = 0;
    reconcileChildren(parent, [a, b, c]);
    b.focus();
    const [x] = make(["x"]);
    reconcileChildren(parent, [x, b]);
    expect(document.activeElement).toBe(b);
    parent.remove();
  });
});
