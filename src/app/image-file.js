/**
 * Read an image file the user picked into what the asset registry stores: mime type, name and
 * base64 bytes, plus its natural size for sizing the image on the page. Shared by the document
 * and presentation insert controls; the registry itself validates again when the command runs.
 */

import { MAX_ASSET_BYTES, isImageMime, parseDataUrl } from "../workspace/assets.js";

/**
 * @typedef {object} ImageFile
 * @property {string} mimeType
 * @property {string} name
 * @property {string} data Base64 bytes.
 * @property {number} width Natural width in pixels, 0 when the browser could not measure it.
 * @property {number} height
 */

/**
 * @param {File} file
 * @returns {Promise<ImageFile>} Rejects with an Error whose message is fit to show the user.
 */
export function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!isImageMime(file.type)) {
      reject(new Error("That file is not a supported image"));
      return;
    }
    if (file.size > MAX_ASSET_BYTES) {
      reject(new Error(`Images can be at most ${Math.round(MAX_ASSET_BYTES / (1024 * 1024))} MB`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that image"));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const parsed = parseDataUrl(url);
      if (!parsed) {
        reject(new Error("Could not read that image"));
        return;
      }
      const img = new Image();
      img.onload = () => resolve({ mimeType: file.type, name: file.name, data: parsed.data, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("Could not read that image"));
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}
