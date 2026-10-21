/**
 * Inserting an image into a document: pick a file, store its bytes once in the workspace's asset
 * registry, and add an `image` block that refers to it by id. The store and the block go in one
 * transaction, so one undo removes the block.
 */

import { readImageFile } from "./image-file.js";

/**
 * @param {{
 *   workspace: import("../workspace/store.js").Workspace,
 *   notice: import("./notice.js").Notice,
 *   insertAfterActive: (spec: { type: string, [key: string]: unknown }) => string | null
 * }} deps `workspace` is the host workspace: assets belong to it, whichever editor draws the block.
 */
export function createImageInsert({ workspace, notice, insertAfterActive }) {
  /**
   * @param {{ mimeType: string, name: string, data: string }} image
   * @returns {string | null} The new block's id.
   */
  function insert(image) {
    /** @type {string | null} */
    let blockId = null;
    notice.guard(() => workspace.transact("Insert image", () => {
      const { assetId } = /** @type {{ assetId: string }} */ (workspace.dispatch("addAsset", image));
      blockId = insertAfterActive({ type: "image", assetId, alt: image.name.replace(/\.[^.]*$/, "") });
    }));
    return blockId;
  }

  /** @param {File} file */
  function insertFile(file) {
    return readImageFile(file).then(insert, (error) => {
      notice.show(error.message);
      return null;
    });
  }

  /** Open the browser's file chooser and insert the chosen image. */
  function pick() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) insertFile(file);
    });
    input.click();
  }

  return { insert, insertFile, pick };
}
