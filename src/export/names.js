/**
 * Names for exported files. Page names are compared case-insensitively and after Unicode
 * normalisation (so "Café" typed two ways is one name), and an exported file name must stay
 * unique under the same rule because common file systems ignore case.
 */

/**
 * The key two names are compared by.
 * @param {string} name
 * @returns {string}
 */
export function nameKey(name) {
  return String(name).normalize("NFC").trim().toLocaleLowerCase("en-US");
}

/**
 * A file-system-safe version of a title: path separators and reserved characters become `-`,
 * spaces become `-`, and the result is never empty.
 * @param {string} title
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugify(title, fallback = "untitled") {
  const slug = String(title ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|#%&{}$!'`@+=~^\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
    .replace(/[-.]+$/g, "");
  return slug || fallback;
}

/**
 * Take the first free `base`, `base-2`, `base-3`... (compared by `nameKey`) and mark it taken.
 * @param {string} base
 * @param {Set<string>} taken Keys already in use.
 * @returns {string}
 */
export function uniqueName(base, taken) {
  let candidate = base;
  for (let n = 2; taken.has(nameKey(candidate)); n++) candidate = `${base}-${n}`;
  taken.add(nameKey(candidate));
  return candidate;
}

/**
 * The relative address from the file at `from` to the file at `to` (both `/`-separated paths
 * from the export root), with each segment percent-encoded.
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relativePath(from, to) {
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  let shared = 0;
  while (shared < a.length && shared < b.length - 1 && a[shared] === b[shared]) shared++;
  const up = a.slice(shared).map(() => "..");
  return [...up, ...b.slice(shared).map(encodeURIComponent)].join("/");
}
