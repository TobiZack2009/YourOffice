import { describe, expect, it } from "vitest";
import {
  validateWorkspace,
  migrateWorkspace,
  SCHEMA_VERSION,
  WORKSPACE_FORMAT,
  PAGE_TYPES
} from "../src/workspace/schema.js";

/** @returns minimal valid workspace data */
function validDoc(overrides = {}) {
  const base = {
    format: WORKSPACE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      id: "workspace_01",
      title: "My Workspace",
      createdAt: "2026-10-17T10:00:00.000Z",
      modifiedAt: "2026-10-17T10:00:00.000Z"
    },
    pages: {
      doc_01: {
        id: "doc_01",
        type: "document",
        title: "Notes",
        createdAt: "2026-10-17T10:00:00.000Z",
        modifiedAt: "2026-10-17T10:00:00.000Z"
      }
    },
    pageOrder: { root: ["doc_01"] },
    settings: { locale: "en-GB" }
  };
  return { ...base, ...overrides };
}

describe("validateWorkspace", () => {
  it("accepts a minimal valid document", () => {
    const check = validateWorkspace(validDoc());
    expect(check.valid).toBe(true);
    expect(check.errors).toEqual([]);
  });

  it("rejects non-objects", () => {
    for (const bad of [null, 42, "x", [], undefined]) {
      expect(validateWorkspace(bad).valid).toBe(false);
    }
  });

  it("requires the canonical format and version", () => {
    const check = validateWorkspace({ ...validDoc(), format: "OtherFormat", schemaVersion: 99 });
    expect(check.valid).toBe(false);
    expect(check.errors.some((e) => e.includes("format"))).toBe(true);
    expect(check.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  it("validates metadata fields", () => {
    const doc = validDoc({
      metadata: { id: "", title: 5, createdAt: "yesterday", modifiedAt: "2026-10-17T10:00:00Z" }
    });
    const check = validateWorkspace(doc);
    expect(check.errors.some((e) => e.includes("metadata.id"))).toBe(true);
    expect(check.errors.some((e) => e.includes("metadata.title"))).toBe(true);
    expect(check.errors.some((e) => e.includes("metadata.createdAt"))).toBe(true);
    expect(check.errors.some((e) => e.includes("metadata.modifiedAt"))).toBe(false);
    // "2026-10-17T10:00:00Z" is a valid ISO UTC second-precision timestamp.
  });

  it("requires a known page type", () => {
    const doc = validDoc();
    /** @type {Record<string, unknown>} */ (doc.pages).fake_01 = {
      id: "fake_01",
      type: "spreadsheet",
      title: "Bad",
      createdAt: "2026-10-17T10:00:00.000Z",
      modifiedAt: "2026-10-17T10:00:00.000Z"
    };
    doc.pageOrder.root.push("fake_01");
    const check = validateWorkspace(doc);
    expect(check.valid).toBe(false);
    expect(check.errors.some((e) => e.includes('pages["fake_01"].type'))).toBe(true);
  });

  it("requires page id to match its key", () => {
    const doc = validDoc();
    doc.pages.doc_01 = { ...doc.pages.doc_01, id: "other_01" };
    const check = validateWorkspace(doc);
    expect(check.errors.some((e) => e.includes("must match its key"))).toBe(true);
  });

  it("flags unknown page references in pageOrder.root", () => {
    const check = validateWorkspace(validDoc({ pageOrder: { root: ["missing_01"] } }));
    expect(check.errors.some((e) => e.includes("unknown page"))).toBe(true);
  });

  it("flags pages not reachable in the hierarchy", () => {
    const doc = validDoc();
    // add second page but keep only doc_01 in the hierarchy
    doc.pages.sheet_01 = {
      id: "sheet_01",
      type: "sheet",
      title: "Budget",
      createdAt: "2026-10-17T10:00:00.000Z",
      modifiedAt: "2026-10-17T10:00:00.000Z"
    };
    const check = validateWorkspace(doc);
    expect(check.errors.some((e) => e.includes('page "sheet_01" is not reachable'))).toBe(true);
  });

  it("flags duplicate membership in the hierarchy", () => {
    const doc = validDoc();
    doc.pages.sheet_01 = {
      id: "sheet_01",
      type: "sheet",
      title: "Budget",
      createdAt: "2026-10-17T10:00:00.000Z",
      modifiedAt: "2026-10-17T10:00:00.000Z"
    };
    doc.pageOrder = { root: ["doc_01", "sheet_01"], doc_01: ["sheet_01"] };
    const check = validateWorkspace(doc);
    expect(check.errors.some((e) => e.includes("more than one parent"))).toBe(true);
  });

  it("rejects a parent cycle", () => {
    const doc = validDoc();
    doc.pages.sheet_01 = {
      id: "sheet_01",
      type: "sheet",
      title: "Budget",
      createdAt: "2026-10-17T10:00:00.000Z",
      modifiedAt: "2026-10-17T10:00:00.000Z"
    };
    doc.pageOrder = { root: [], doc_01: ["sheet_01"], sheet_01: ["doc_01"] };
    const check = validateWorkspace(doc);
    expect(check.valid).toBe(false);
    expect(check.errors.some((e) => e.includes("parent cycle"))).toBe(true);
  });

  it("supports nesting and pass-through pages with empty child lists", () => {
    const doc = validDoc();
    doc.pages.sheet_01 = {
      id: "sheet_01",
      type: "sheet",
      title: "Budget",
      createdAt: "2026-10-17T10:00:00.000Z",
      modifiedAt: "2026-10-17T10:00:00.000Z"
    };
    doc.pageOrder = { root: ["doc_01"], doc_01: ["sheet_01"], sheet_01: [] };
    expect(validateWorkspace(doc).valid).toBe(true);
  });

  it("accepts missing settings", () => {
    const doc = validDoc();
    delete /** @type {Record<string, unknown>} */ (doc).settings;
    expect(validateWorkspace(doc).valid).toBe(true);
  });
});

describe("migrateWorkspace", () => {
  it("passes through current-version documents unchanged", () => {
    const result = migrateWorkspace(validDoc());
    expect(result.data).toEqual(validDoc());
    expect(result.appliedMigrationSteps).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("rejects unknown future versions with a clear error", () => {
    const result = migrateWorkspace(validDoc({ schemaVersion: 99 }));
    expect(result.data).toBeNull();
    expect(result.errors[0]).toContain("no migration path");
  });
});

describe("PAGE_TYPES", () => {
  it("covers document, sheet, presentation", () => {
    expect(PAGE_TYPES).toEqual(["document", "sheet", "presentation"]);
  });
});
