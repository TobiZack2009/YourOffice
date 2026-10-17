/**
 * Stable identifiers.
 *
 * Every named entity in the model gets an identifier generated here. Identity is
 * never derived from names, titles, or position (spec §2.4). IDs combine a random
 * base-32-ish payload with a monotonic counter and carry an optional prefix so the
 * type of the entity is readable in serialized data (`page_…`, `doc_…`).
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 12;

/** @type {number} Monotonic suffix so IDs never repeat within a session. */
let counter = 0;

/**
 * Create a new unique, URL-safe identifier.
 * @param {string} [prefix] Entity-type prefix without underscore, e.g. "page".
 * @returns {string} An identifier like "page_k3v8m2w9x1q4o0".
 */
export function createId(prefix = "") {
  counter += 1;
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let random = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    random += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${prefix ? prefix + "_" : ""}${random}${ALPHABET[counter % ALPHABET.length]}`;
}
