/**
 * URL safety shared by the model validators, the renderers and the link form.
 * Anything stored as a link target (a document link mark, a slide object link) must pass
 * `isSafeUrl`; renderers drop what does not, so imported data can never run script on click.
 */

/** Schemes a link may use. Page links are `#<pageId>`, relative addresses have no scheme. */
const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel", "ftp", "sms"]);

/**
 * Whether a link target is safe to put in an `href` or hand to `window.open`.
 * Browsers ignore tabs, newlines and other control characters inside a scheme
 * (`java\tscript:`), so those are stripped before the scheme is read.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
  if (typeof url !== "string") return false;
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (compact.length === 0) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return true;
  return SAFE_SCHEMES.has(scheme[1].toLowerCase());
}
