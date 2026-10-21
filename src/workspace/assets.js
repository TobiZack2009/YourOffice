/**
 * The asset registry: binary content (images) stored once per workspace and referenced by id.
 *
 * Pages never hold image bytes. A document `image` block and a slide `image` object carry an
 * `assetId`; the bytes live here, embedded as base64, so a workspace is one self-contained
 * document and an image used twice is stored once. Assets are immutable and content-addressed
 * by comparison: adding bytes already present returns the existing id.
 *
 * The registry lives beside `_data`, not in it, because history snapshots clone `_data` for every
 * transaction and megabytes of image data must not ride along. It joins the serialized form
 * (`assets`) and is read back from it. Undo never removes an asset (a redo may need it); assets
 * nothing uses any more are dropped the next time the workspace is loaded.
 *
 * Everything here is pure data handling, with no DOM and no knowledge of the editors beyond the
 * one convention they share: a node `{ type: "image", assetId }`.
 *
 * @typedef {object} Asset
 * @property {string} id
 * @property {"image"} kind
 * @property {string} mimeType
 * @property {string} name Original file name (a label; never used as a path).
 * @property {number} size Decoded size in bytes.
 * @property {{ mode: "embedded", data: string }} storage Base64 data.
 */

import { createId } from "../core/ids.js";
import { CommandError } from "../core/errors.js";

/** Largest single asset, decoded. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_NAME = 255;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} mimeType @returns {boolean} */
export function isImageMime(mimeType) {
  return typeof mimeType === "string" && IMAGE_MIME.test(mimeType);
}

/**
 * Decoded size of a base64 string, or -1 when it is not well formed base64.
 * @param {unknown} data
 * @returns {number}
 */
export function base64Size(data) {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return -1;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * Split a `data:<mime>;base64,<data>` URL.
 * @param {unknown} url
 * @returns {{ mimeType: string, data: string } | null} Null for anything else (including a non-base64 data URL).
 */
export function parseDataUrl(url) {
  if (typeof url !== "string") return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mimeType: match[1].toLowerCase(), data: match[2] } : null;
}

/**
 * @param {Pick<Asset, "mimeType" | "storage">} asset
 * @returns {string} A `data:` URL for the asset.
 */
export function assetDataUrl(asset) {
  return `data:${asset.mimeType};base64,${asset.storage.data}`;
}

/**
 * Problems with one asset record; empty when it is sound.
 * @param {unknown} asset
 * @param {string} [key] The id it is stored under, which it must equal.
 * @returns {string[]}
 */
export function validateAsset(asset, key) {
  if (!isPlainObject(asset)) return ["asset must be an object"];
  /** @type {string[]} */
  const errors = [];
  if (typeof asset.id !== "string" || asset.id.length === 0) errors.push("asset.id must be a non-empty string");
  else if (key !== undefined && asset.id !== key) errors.push("asset.id must match its key");
  if (asset.kind !== "image") errors.push('asset.kind must be "image"');
  if (!isImageMime(asset.mimeType)) errors.push("asset.mimeType must be a supported image type");
  if (typeof asset.name !== "string" || asset.name.length > MAX_NAME) errors.push(`asset.name must be a string of at most ${MAX_NAME} characters`);
  const storage = asset.storage;
  if (!isPlainObject(storage) || storage.mode !== "embedded") {
    errors.push('asset.storage.mode must be "embedded"');
    return errors;
  }
  const size = base64Size(storage.data);
  if (size < 0) errors.push("asset.storage.data must be base64");
  else if (size > MAX_ASSET_BYTES) errors.push(`asset is larger than ${MAX_ASSET_BYTES} bytes`);
  else if (asset.size !== size) errors.push("asset.size must equal the decoded size of its data");
  return errors;
}

/**
 * Problems with the whole registry; empty when sound.
 * @param {unknown} assets
 * @returns {string[]}
 */
export function validateAssets(assets) {
  if (!isPlainObject(assets)) return ["assets must be an object"];
  return Object.entries(assets).flatMap(([key, asset]) => validateAsset(asset, key).map((m) => `assets["${key}"]: ${m}`));
}

/**
 * Call `visit` for every `{ type: "image" }` node found anywhere under `root` (document image
 * blocks, slide image objects, in pages and in detached content alike).
 * @param {unknown} root
 * @param {(node: Record<string, any>) => void} visit
 */
export function forEachImage(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) if (typeof child === "object" && child !== null) stack.push(child);
    } else if (isPlainObject(node)) {
      if (node.type === "image") visit(node);
      for (const child of Object.values(node)) if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
}

/**
 * Ids of the assets a serialized workspace uses.
 * @param {{ pages?: unknown, detached?: unknown }} data
 * @returns {Set<string>}
 */
export function usedAssetIds(data) {
  /** @type {Set<string>} */
  const used = new Set();
  const collect = (/** @type {Record<string, any>} */ node) => {
    if (typeof node.assetId === "string" && node.assetId) used.add(node.assetId);
  };
  forEachImage(data.pages, collect);
  forEachImage(data.detached, collect);
  return used;
}

/**
 * Every image node that names an asset the registry does not hold.
 * @param {{ pages?: unknown, detached?: unknown, assets?: Record<string, unknown> }} data
 * @returns {string[]} Messages for the integrity check.
 */
export function validateAssetReferences(data) {
  const assets = data.assets ?? {};
  return [...usedAssetIds(data)].filter((id) => !Object.hasOwn(assets, id)).map((id) => `image uses unknown asset "${id}"`);
}

/**
 * Add an asset to a registry, or find the identical one already there.
 * @param {Record<string, Asset>} assets Mutated.
 * @param {{ mimeType: string, name?: string, data: string }} fields
 * @returns {string} The asset id.
 * @throws {CommandError} When the fields are not a storable image.
 */
export function addAssetTo(assets, fields) {
  const mimeType = typeof fields.mimeType === "string" ? fields.mimeType.toLowerCase() : "";
  if (!isImageMime(mimeType)) throw new CommandError("mimeType must be a supported image type", "invalidAsset");
  const size = base64Size(fields.data);
  if (size < 0) throw new CommandError("data must be base64", "invalidAsset");
  if (size > MAX_ASSET_BYTES) {
    throw new CommandError(`images can be at most ${Math.round(MAX_ASSET_BYTES / (1024 * 1024))} MB`, "assetTooLarge");
  }
  for (const asset of Object.values(assets)) {
    if (asset.size === size && asset.mimeType === mimeType && asset.storage.data === fields.data) return asset.id;
  }
  const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim().slice(0, MAX_NAME) : "image";
  const id = createId("asset");
  assets[id] = { id, kind: "image", mimeType, name, size, storage: { mode: "embedded", data: fields.data } };
  return id;
}

/**
 * Register the asset commands on a workspace.
 * @param {import("./store.js").Workspace} store
 */
export function registerAssetCommands(store) {
  // Hot: it cannot move or remove structure, so reference bookkeeping has nothing to check.
  store.registerCommand(
    "addAsset",
    (workspace, _tx, payload) => {
      const p = /** @type {Record<string, any>} */ (payload ?? {});
      return { assetId: addAssetTo(workspace._assets, { mimeType: p.mimeType, name: p.name, data: p.data }) };
    },
    { hot: true }
  );
}
