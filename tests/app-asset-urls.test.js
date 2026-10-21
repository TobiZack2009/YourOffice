import { describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createAssetUrls } from "../src/app/asset-urls.js";

function setup() {
  const ws = createWorkspace({ title: "W" });
  const { assetId } = ws.dispatch("addAsset", { mimeType: "image/png", name: "a.png", data: "iVBORw0KGgo=" });
  return { ws, assetId };
}

describe("createAssetUrls", () => {
  it("makes one object URL per asset and reuses it", () => {
    const { ws, assetId } = setup();
    const urlApi = { createObjectURL: vi.fn(() => "blob:one"), revokeObjectURL: vi.fn() };
    const urls = createAssetUrls(ws, urlApi);
    expect(urls.url(assetId)).toBe("blob:one");
    expect(urls.url(assetId)).toBe("blob:one");
    expect(urlApi.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = urlApi.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(8);
  });

  it("revokes what it made when destroyed", () => {
    const { ws, assetId } = setup();
    const urlApi = { createObjectURL: () => "blob:one", revokeObjectURL: vi.fn() };
    const urls = createAssetUrls(ws, urlApi);
    urls.url(assetId);
    urls.destroy();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:one");
  });

  it("answers undefined for an asset the workspace does not hold", () => {
    const { ws } = setup();
    expect(createAssetUrls(ws, { createObjectURL: () => "blob:x" }).url("asset_missing")).toBeUndefined();
  });

  it("falls back to a data URL where object URLs do not exist", () => {
    const { ws, assetId } = setup();
    expect(createAssetUrls(ws, {}).url(assetId)).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});
