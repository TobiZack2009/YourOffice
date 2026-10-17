import { describe, expect, it } from "vitest";
import { createId } from "../src/core/ids.js";

describe("createId", () => {
  it("uses the given prefix", () => {
    const id = createId("page");
    expect(id.startsWith("page_")).toBe(true);
  });

  it("returns identifiers without a prefix", () => {
    const id = createId();
    expect(id.length).toBeGreaterThan(6);
    expect(id).toMatch(/^[0-9a-z_]+$/);
  });

  it("generates unique ids across many calls", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => createId("t")));
    expect(ids.size).toBe(2000);
    for (const id of ids) {
      expect(id.startsWith("t_")).toBe(true);
      expect(id).not.toContain("i");
      expect(id).not.toContain("l");
      expect(id).not.toContain("o");
      expect(id).not.toContain("u");
    }
  });
});
