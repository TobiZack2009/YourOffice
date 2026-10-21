/**
 * Schema v1 -> v2 for presentations: a slide image used to carry its bytes as a `src` data URL;
 * they now live in the workspace's asset registry and the object carries an `assetId`.
 *
 * Pure JSON in, JSON out. The input is never modified (the result shares nothing it changes).
 */

import { addAssetTo, forEachImage, parseDataUrl } from "../workspace/assets.js";

/**
 * @param {Record<string, any>} data A schema v1 workspace document with an `assets` registry.
 * @returns {Record<string, any>}
 */
export function moveImagesToAssets(data) {
  const touched = JSON.stringify([data.pages, data.detached]).includes('"src"');
  if (!touched) return data;
  /** @type {Record<string, any>} */
  const next = { ...data, assets: { ...data.assets }, pages: structuredClone(data.pages) };
  if (data.detached !== undefined) next.detached = structuredClone(data.detached);
  const visit = (/** @type {Record<string, any>} */ node) => {
    if (!("src" in node)) return;
    const parsed = parseDataUrl(node.src);
    let assetId = "";
    if (parsed) {
      try {
        assetId = addAssetTo(next.assets, { ...parsed, name: typeof node.name === "string" ? node.name : "image" });
      } catch {
        // An image that cannot be stored (external address, too large, unsupported type) loses its source and stays as an empty image, rather than failing the whole workspace.
      }
    }
    node.assetId = assetId;
    delete node.src;
  };
  forEachImage(next.pages, visit);
  forEachImage(next.detached, visit);
  return next;
}
