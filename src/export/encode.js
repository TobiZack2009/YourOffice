/**
 * Text and bytes conversions shared by the exporters.
 */

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
export function utf8(text) {
  return new TextEncoder().encode(text);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * An SVG document as a `data:` address, safe to use as an image source.
 * @param {string} svg
 * @returns {string}
 */
export function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${toBase64(utf8(svg))}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
