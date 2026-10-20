import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { exportWorkspaceJSON, importWorkspaceJSON } from "../src/workspace/format.js";
import { WorkspaceFormatError } from "../src/core/errors.js";

describe("JSON round trip", () => {
  it("export → import → export is stable", () => {
    const ws = Workspace.create({ title: "Round Trip" });
    ws.dispatch("createPage", { type: "document", title: "Notes" });
    ws.dispatch("createPage", { type: "sheet", title: "Budget" });
    const parentId = ws.getChildren(null)[0];
    ws.dispatch("createPage", { type: "document", title: "Child", parentId });
    const content = {
      blockOrder: ["b1"],
      blocks: { b1: { id: "b1", type: "paragraph", runs: [{ text: "Hello" }] } }
    };
    ws.dispatch("setPageContent", { pageId: parentId, content });

    const json = exportWorkspaceJSON(ws);
    const restored = importWorkspaceJSON(json);

    expect(restored.title).toBe("Round Trip");
    expect(restored.id).toBe(ws.id);
    expect(restored.getPages()).toEqual(ws.getPages());
    expect(restored.getChildren(null)).toEqual(ws.getChildren(null));
    expect(restored.getChildren(parentId)).toEqual(ws.getChildren(parentId));
    expect(restored.getPage(parentId)?.content).toEqual(content);
    expect(exportWorkspaceJSON(restored)).toBe(json);
    expect(restored.dirty).toBe(false);
  });

  it("supports compact output", () => {
    const ws = Workspace.create({ title: "Compact" });
    expect(exportWorkspaceJSON(ws, { pretty: false })).not.toContain("\n");
  });

  it("rejects malformed JSON with WorkspaceFormatError", () => {
    expect(() => importWorkspaceJSON("{not json")).toThrow(WorkspaceFormatError);
  });

  it("rejects invalid schema data with the validation messages", () => {
    expect(() => importWorkspaceJSON('{"format":"nope"}')).toThrow(/schemaVersion/);
  });

  it("validates plain objects handed to Workspace.fromJSON", () => {
    expect(() => Workspace.fromJSON(42)).toThrow(WorkspaceFormatError);
  });
});
