/**
 * Formula tokenizer (spec §6.5: parse formulas into an expression representation).
 *
 * Converts formula text into a flat token stream for the parser. No eval, no
 * regex-only parsing of whole expressions: numbers, strings, booleans, error
 * literals, references, names, operators and punctuation each get a token with
 * a source position for good diagnostics.
 *
 * Formula text may optionally include a leading "=", which is ignored.
 */

import { errorFromLiteral } from "./errors.js";

/**
 * @typedef {{ type: string, [key: string]: unknown }} Token
 */

/** Multi-character operators, longest first so `<=` beats `<`. */
const OPERATORS = ["<=", ">=", "<>", "+", "-", "*", "/", "^", "&", "%", "=", "<", ">"];

/** Characters that start a word (reference, name, boolean). */
const WORD_START = /[A-Za-z_$]/;
const WORD_CHARS = /[A-Za-z0-9_$.]/;

export class FormulaSyntaxError extends Error {
  /**
   * @param {string} message
   * @param {number} position Character offset in the (de-equalised) input.
   */
  constructor(message, position) {
    super(`${message} at position ${position}`);
    this.name = "FormulaSyntaxError";
    /** @type {number} */
    this.position = position;
  }
}

/**
 * Tokenize formula text.
 * @param {string} input Formula text, with or without a leading "=".
 * @returns {Token[]} Tokens ending with an "eof" token.
 * @throws {FormulaSyntaxError} On unterminated strings or unknown characters.
 */
export function tokenize(input) {
  let text = input;
  if (text.startsWith("=")) text = text.slice(1);

  /** @type {Token[]} */
  const tokens = [];
  let i = 0;

  const push = (type, value) => tokens.push({ type, value, pos: i });

  while (i < text.length) {
    const ch = text[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }

    // Number: digits with optional decimal part and exponent.
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const start = i;
      while (i < text.length && /[0-9]/.test(text[i])) i += 1;
      if (text[i] === ".") {
        i += 1;
        while (i < text.length && /[0-9]/.test(text[i])) i += 1;
      }
      if (text[i] === "e" || text[i] === "E") {
        const exponentStart = i;
        i += 1;
        if (text[i] === "+" || text[i] === "-") i += 1;
        if (/[0-9]/.test(text[i] ?? "")) {
          while (i < text.length && /[0-9]/.test(text[i])) i += 1;
        } else {
          i = exponentStart;
        }
      }
      const literal = text.slice(start, i);
      tokens.push({ type: "number", value: Number(literal), literal, pos: start });
      continue;
    }

    // String literal with doubled-quote escaping.
    if (ch === '"') {
      const start = i;
      i += 1;
      let value = "";
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i += 1;
            closed = true;
            break;
          }
        } else {
          value += text[i];
          i += 1;
        }
      }
      if (!closed) throw new FormulaSyntaxError("unterminated string literal", start);
      tokens.push({ type: "string", value, pos: start });
      continue;
    }

    // Error literal, e.g. #REF!, #DIV/0!.
    if (ch === "#") {
      const start = i;
      i += 1;
      while (i < text.length && /[A-Za-z0-9/!?]/.test(text[i])) i += 1;
      const literal = text.slice(start, i);
      const error = errorFromLiteral(literal);
      if (!error) throw new FormulaSyntaxError(`unknown error literal "${literal}"`, start);
      tokens.push({ type: "error", value: error.code, pos: start });
      continue;
    }

    // Word: reference, name, or boolean.
    if (WORD_START.test(ch)) {
      const start = i;
      i += 1;
      while (i < text.length && WORD_CHARS.test(text[i])) i += 1;
      const word = text.slice(start, i);
      if (word === "TRUE" || word === "FALSE") {
        tokens.push({ type: "boolean", value: word === "TRUE", pos: start });
      } else {
        tokens.push({ type: "word", value: word, pos: start });
      }
      continue;
    }

    if (ch === "(") {
      push("lparen", ch);
      i += 1;
      continue;
    }
    if (ch === ")") {
      push("rparen", ch);
      i += 1;
      continue;
    }
    if (ch === "," || ch === ";") {
      push("comma", ch);
      i += 1;
      continue;
    }
    if (ch === ":") {
      push("colon", ch);
      i += 1;
      continue;
    }

    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (operator) {
      push("op", operator);
      i += operator.length;
      continue;
    }

    throw new FormulaSyntaxError(`unexpected character "${ch}"`, i);
  }

  tokens.push({ type: "eof", value: null, pos: text.length });
  return tokens;
}
