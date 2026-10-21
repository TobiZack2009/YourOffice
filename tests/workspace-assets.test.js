import { describe, expect, it } from "vitest";
import { createWorkspace, exportWorkspaceJSON, importWorkspaceJSON, validateDomain, workspaceFromJSON } from "../src/domain/index.js";
import { MAX_ASSET_BYTES, addAssetTo, base64Size, parseDataUrl, usedAssetIds, validateAsset } from "../src/workspace/assets.js";
import { createObject } from "../src/presentation/model.js";
import { WorkspaceFormatError } from "../src/core/errors.js";

const PNG = { mimeType: "image/png", name: "dot.png", data: "iVBORw0KGgo=" };

function withDocument() {
  const ws = createWorkspace({ title: "W" });
  const { pageId } = ws.dispatch("createPage", { type: "document", title: "Doc" });
  return { ws, pageId };
}

function withImage() {
  const { ws, pageId } = withDocument();
  const { assetId } = ws.dispatch("addAsset", PNG);
  const { blockId } = ws.dispatch("insertBlock", { pageId, block: { type: "image", assetId } });
  return { ws, pageId, assetId, blockId };
}

describe("asset data helpers", () => {
  it("measures base64 and rejects malformed data", () => {
    expect(base64Size("AAAA")).toBe(3);
    expect(base64Size("AAA=")).toBe(2);
    expect(base64Size("AA==")).toBe(1);
    expect(base64Size("")).toBe(-1);
    expect(base64Size("AAA")).toBe(-1);
    expect(base64Size("AA*A")).toBe(-1);
  });

  it("splits base64 data URLs only", () => {
    expect(parseDataUrl("data:image/png;base64,AAAA")).toEqual({ mimeType: "image/png", data: "AAAA" });
    expect(parseDataUrl("data:text/plain,hello")).toBeNull();
    expect(parseDataUrl("https://x.test/a.png")).toBeNull();
  });

  it("validates a record against its key, type, size and bytes", () => {
    const good = { id: "a", kind: "image", mimeType: "image/png", name: "n", size: 3, storage: { mode: "embedded", data: "AAAA" } };
    expect(validateAsset(good, "a")).toEqual([]);
    expect(validateAsset(good, "b")).not.toEqual([]);
    expect(validateAsset({ ...good, size: 4 }, "a")).not.toEqual([]);
    expect(validateAsset({ ...good, mimeType: "text/html" }, "a")).not.toEqual([]);
    expect(validateAsset({ ...good, storage: { mode: "url", url: "https://x.test" } }, "a")).not.toEqual([]);
  });
});

describe("addAsset", () => {
  it("stores an image and returns its id", () => {
    const { ws } = withDocument();
    const { assetId } = ws.dispatch("addAsset", PNG);
    expect(ws.getAsset(assetId)).toMatchObject({ id: assetId, kind: "image", mimeType: "image/png", name: "dot.png", size: 8 });
    expect(ws.assetIds()).toEqual([assetId]);
  });

  it("returns the existing id for identical bytes", () => {
    const { ws } = withDocument();
    const first = ws.dispatch("addAsset", PNG).assetId;
    expect(ws.dispatch("addAsset", { ...PNG, name: "renamed.png" }).assetId).toBe(first);
    expect(ws.assetIds()).toHaveLength(1);
    expect(ws.dispatch("addAsset", { ...PNG, mimeType: "image/gif" }).assetId).not.toBe(first);
  });

  it("refuses what is not a storable image", () => {
    const { ws } = withDocument();
    const reason = (payload) => {
      try {
        ws.dispatch("addAsset", payload);
      } catch (error) {
        return error.reason;
      }
      return null;
    };
    expect(reason({ ...PNG, mimeType: "text/html" })).toBe("invalidAsset");
    expect(reason({ ...PNG, data: "not base64!" })).toBe("invalidAsset");
    expect(reason({ ...PNG, data: "A".repeat(Math.ceil((MAX_ASSET_BYTES + 3) / 3) * 4) })).toBe("assetTooLarge");
    expect(ws.assetIds()).toEqual([]);
  });

  it("is a pure registry change: addAssetTo works on a bare map", () => {
    const assets = {};
    expect(addAssetTo(assets, { mimeType: "IMAGE/PNG", data: "AAAA" })).toBeTruthy();
    expect(Object.values(assets)[0]).toMatchObject({ mimeType: "image/png", name: "image" });
  });
});

describe("assets and history", () => {
  it("keeps the asset when the block that uses it is undone, so redo still draws it", () => {
    const { ws, pageId, assetId, blockId } = withImage();
    ws.undo();
    expect(ws.getAsset(assetId)).toBeTruthy();
    ws.redo();
    expect(ws.getPage(pageId).content.blocks[blockId].assetId).toBe(assetId);
  });

  it("does not put image bytes in history snapshots", () => {
    const { ws } = withImage();
    expect(JSON.stringify(ws.data)).not.toContain(PNG.data);
  });
});

describe("serialization", () => {
  it("round-trips assets through export and import", () => {
    const { ws, assetId } = withImage();
    const restored = importWorkspaceJSON(exportWorkspaceJSON(ws));
    expect(restored.getAsset(assetId)).toEqual(ws.getAsset(assetId));
    expect(exportWorkspaceJSON(restored)).toBe(exportWorkspaceJSON(ws));
  });

  it("drops assets nothing uses when a workspace is loaded", () => {
    const { ws, pageId, assetId, blockId } = withImage();
    ws.dispatch("deleteBlock", { pageId, blockId });
    expect(ws.getAsset(assetId)).toBeTruthy();
    expect(workspaceFromJSON(JSON.parse(exportWorkspaceJSON(ws))).assetIds()).toEqual([]);
  });

  it("counts images in presentations and in detached content as users", () => {
    const { ws } = withDocument();
    const { pageId } = ws.dispatch("createPage", { type: "presentation", title: "Deck" });
    const { slideId } = ws.dispatch("createSlide", { pageId, layout: "blank" });
    const { assetId } = ws.dispatch("addAsset", PNG);
    ws.dispatch("insertObject", { pageId, slideId, object: createObject("image", { assetId, width: 10, height: 10 }) });
    expect(usedAssetIds(ws.data)).toEqual(new Set([assetId]));
    expect(workspaceFromJSON(JSON.parse(exportWorkspaceJSON(ws))).assetIds()).toEqual([assetId]);
  });

  it("rejects an image that names an asset the file does not hold", () => {
    const { ws } = withImage();
    const json = JSON.parse(exportWorkspaceJSON(ws));
    json.assets = {};
    expect(validateDomain(json).errors.join("\n")).toMatch(/unknown asset/);
    expect(() => workspaceFromJSON(json)).toThrow(WorkspaceFormatError);
  });

  it("rejects a malformed asset record", () => {
    const { ws, assetId } = withImage();
    const json = JSON.parse(exportWorkspaceJSON(ws));
    json.assets[assetId].storage.data = "***";
    expect(() => workspaceFromJSON(json)).toThrow(WorkspaceFormatError);
  });
});

describe("migration from schema 1", () => {
  /** A version 1 file: slide images carried their bytes as a `src` data URL, and there was no registry. */
  function version1() {
    const ws = createWorkspace({ title: "Old" });
    const { pageId } = ws.dispatch("createPage", { type: "presentation", title: "Deck" });
    const { slideId } = ws.dispatch("createSlide", { pageId, layout: "blank" });
    const json = JSON.parse(exportWorkspaceJSON(ws));
    const slide = json.pages[pageId].content.slides[slideId];
    const image = (id, src) => ({ ...createObject("image", { width: 20, height: 20 }), id, src });
    slide.objects = { i1: image("i1", `data:image/png;base64,${PNG.data}`), i2: image("i2", `data:image/png;base64,${PNG.data}`), i3: image("i3", "https://x.test/a.png") };
    for (const object of Object.values(slide.objects)) delete object.assetId;
    slide.objectOrder = ["i1", "i2", "i3"];
    json.schemaVersion = 1;
    delete json.assets;
    return { json, pageId, slideId };
  }

  it("moves src data URLs into the registry, storing equal bytes once", () => {
    const { json, pageId, slideId } = version1();
    const ws = importWorkspaceJSON(JSON.stringify(json));
    const slide = ws.getPage(pageId).content.slides[slideId];
    expect(ws.assetIds()).toHaveLength(1);
    expect(slide.objects.i1.assetId).toBe(slide.objects.i2.assetId);
    expect(slide.objects.i1).not.toHaveProperty("src");
    expect(ws.getAsset(slide.objects.i1.assetId)).toMatchObject({ mimeType: "image/png", name: "image" });
  });

  it("leaves an image whose source cannot be stored as an empty image", () => {
    const { json, pageId, slideId } = version1();
    const ws = importWorkspaceJSON(JSON.stringify(json));
    const slide = ws.getPage(pageId).content.slides[slideId];
    expect(slide.objectOrder).toEqual(["i1", "i2", "i3"]);
    expect(slide.objects.i3.assetId).toBe("");
    expect(slide.objects.i3).not.toHaveProperty("src");
  });

  it("gives a file without images an empty registry", () => {
    const { json } = version1();
    json.pages = Object.fromEntries(Object.entries(json.pages));
    const plain = createWorkspace({ title: "Plain" });
    const old = JSON.parse(exportWorkspaceJSON(plain));
    old.schemaVersion = 1;
    delete old.assets;
    expect(importWorkspaceJSON(JSON.stringify(old)).assetIds()).toEqual([]);
  });
});
