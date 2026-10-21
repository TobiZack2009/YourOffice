import { describe, expect, it } from "vitest";
import { nameKey, relativePath, slugify, uniqueName } from "../src/export/names.js";

describe("nameKey", () => {
  it("ignores case, surrounding space and Unicode composition", () => {
    expect(nameKey("  Notes ")).toBe(nameKey("NOTES"));
    expect(nameKey("Cafe\u0301")).toBe(nameKey("Caf\u00e9"));
  });
});

describe("slugify", () => {
  it("makes file-system-safe names", () => {
    expect(slugify("My notes / 2024: draft?")).toBe("My-notes-2024-draft");
    expect(slugify("..hidden..")).toBe("hidden");
  });

  it("never returns an empty name", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("///", "page")).toBe("page");
  });

  it("keeps non-Latin letters", () => {
    expect(slugify("日本語 ノート")).toBe("日本語-ノート");
  });

  it("limits the length", () => {
    expect(slugify("a".repeat(300)).length).toBeLessThanOrEqual(80);
  });
});

describe("uniqueName", () => {
  it("numbers repeats, case-insensitively", () => {
    const taken = new Set();
    expect(uniqueName("Notes", taken)).toBe("Notes");
    expect(uniqueName("notes", taken)).toBe("notes-2");
    expect(uniqueName("NOTES", taken)).toBe("NOTES-3");
  });
});

describe("relativePath", () => {
  it("links within a folder, down and up", () => {
    expect(relativePath("a.html", "b.html")).toBe("b.html");
    expect(relativePath("a.html", "dir/b.html")).toBe("dir/b.html");
    expect(relativePath("dir/a.html", "b.html")).toBe("../b.html");
    expect(relativePath("dir/a.html", "dir/sub/b.html")).toBe("sub/b.html");
    expect(relativePath("x/a.html", "y/b.html")).toBe("../y/b.html");
  });

  it("percent-encodes each segment", () => {
    expect(relativePath("a.html", "my dir/ñ page.html")).toBe("my%20dir/%C3%B1%20page.html");
  });
});
