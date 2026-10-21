/**
 * Addresses to show assets from. An asset is base64 in the registry; the browser wants a URL.
 * This turns each asset into an object URL the first time it is drawn, keeps it for the life of
 * the mount and revokes it when the mount ends. Object URLs are runtime only and never stored.
 *
 * Where object URLs do not exist (jsdom, some embedded webviews) it falls back to a `data:` URL.
 * Assets are immutable, so a cached URL is never stale.
 */

import { assetDataUrl } from "../workspace/assets.js";

/**
 * @param {string} base64
 * @returns {Uint8Array<ArrayBuffer>}
 */
function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @param {import("../workspace/store.js").Workspace} workspace
 * @param {{ createObjectURL?: (blob: Blob) => string, revokeObjectURL?: (url: string) => void }} [urlApi]
 *   Injected so a test can watch URLs come and go; defaults to the global `URL`.
 */
export function createAssetUrls(workspace, urlApi = URL) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  const canMakeObjectUrls = typeof urlApi.createObjectURL === "function";

  /**
   * @param {string} assetId
   * @returns {string | undefined} Undefined for an asset the workspace does not hold.
   */
  function url(assetId) {
    const known = cache.get(assetId);
    if (known) return known;
    const asset = workspace.getAsset(assetId);
    if (!asset) return undefined;
    const made = canMakeObjectUrls
      ? /** @type {Required<typeof urlApi>} */ (urlApi).createObjectURL(
          new Blob([decode(asset.storage.data)], { type: asset.mimeType })
        )
      : assetDataUrl(asset);
    cache.set(assetId, made);
    return made;
  }

  return {
    url,
    /** Revoke every object URL made so far. */
    destroy() {
      if (canMakeObjectUrls) for (const made of cache.values()) urlApi.revokeObjectURL?.(made);
      cache.clear();
    }
  };
}
