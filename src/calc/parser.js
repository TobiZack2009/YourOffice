/**
 * Formula parser: token stream → AST (spec §6.5). No eval anywhere.
 *
 * Grammar (recursive descent / precedence climbing):
 *
 *   expression   := comparison
 *   comparison   := concat (("=" | "<>" | "<" | "<=" | ">" | ">=") concat)*
 *   concat       := additive ("&" additive)*
 *   additive     := multiplicative (("+" | "-") multiplicative)*
 *   multiplicative := power (("*" | "/") power)*
 *   power        := unary ("^" unary)*            // right associative
 *   unary        := ("+" | "-") unary | postfix
 *   postfix      := primary ("%")*
 *   primary      := number | string | boolean | error | reference | range
 *                 | call | path | "(" expression ")"
 *   path         := segment ("!" segment)* ("!" address)?
 *   segment      := word | 'quoted name'
 *   address      := A1 | A1:A1            // local to the target named before it
 *
 * Unary minus binds tighter than "^" so `-2^2` is `(-2)^2`, matching Excel.
 */

import { tokenize, FormulaSyntaxError } from "./tokenizer.js";
import { parseA1 } from "./references.js";

/** @typedef {import("./references.js").CellRef} CellRef */
/**
 * @typedef {{ type: "number", value: number }
 *   | { type: "string", value: string }
 *   | { type: "boolean", value: boolean }
 *   | { type: "error", code: string }
 *   | { type: "empty" }
 *   | { type: "ref", ref: CellRef }
 *   | { type: "range", start: CellRef, end: CellRef }
 *   | { type: "name", name: string, quoted?: boolean }
 *   | { type: "path", segments: string[], address: AstNode | null }
 *   | { type: "unary" | "postfix", op: string, operand: AstNode }
 *   | { type: "binary", op: string, left: AstNode, right: AstNode, comparison: boolean }
 *   | { type: "call", name: string, args: AstNode[] }} AstNode
 */
/** @typedef {import("./tokenizer.js").Token} Token */

/** Binary operator precedence; higher binds tighter. */
const BINARY_PRECEDENCE = {
  "=": 1, "<>": 1, "<": 1, "<=": 1, ">": 1, ">=": 1,
  "&": 2,
  "+": 3, "-": 3,
  "*": 4, "/": 4,
  "^": 5
};

const RIGHT_ASSOCIATIVE = new Set(["^"]);
const COMPARISON = new Set(["=", "<>", "<", "<=", ">", ">="]);

/**
 * @param {string} op
 * @returns {boolean}
 */
function isComparison(op) {
  return COMPARISON.has(op);
}

class Parser {
  /** @param {Token[]} tokens */
  constructor(tokens) {
    /** @type {Token[]} */
    this.tokens = tokens;
    /** @type {number} */
    this.pos = 0;
  }

  /** @returns {Token} */
  peek() {
    return this.tokens[this.pos];
  }

  /** @returns {Token} */
  next() {
    return this.tokens[this.pos++];
  }

  /** @returns {boolean} */
  atEnd() {
    return this.peek().type === "eof";
  }

  /**
   * @param {string} expected
   * @param {string} [context]
   */
  expect(expected, context = "expression") {
    const token = this.peek();
    if (token.type !== expected) {
      throw new FormulaSyntaxError(
        `expected ${expected} ${context}, found ${describe(token)}`,
        token.pos
      );
    }
    return this.next();
  }

  /** @returns {AstNode} */
  parseExpression() {
    return this.parseBinary(0);
  }

  /**
   * Precedence-climbing binary parser.
   * @param {number} minPrecedence
   * @returns {AstNode}
   */
  parseBinary(minPrecedence) {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.type !== "op") break;
      const op = /** @type {string} */ (token.value);
      const precedence = BINARY_PRECEDENCE[op];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      const nextMin = RIGHT_ASSOCIATIVE.has(op) ? precedence : precedence + 1;
      const right = this.parseBinary(nextMin);
      left = { type: "binary", op, left, right, comparison: isComparison(op) };
    }
    return left;
  }

  /** @returns {AstNode} */
  parseUnary() {
    const token = this.peek();
    if (token.type === "op" && (token.value === "-" || token.value === "+")) {
      this.next();
      const operand = this.parseUnary();
      return { type: "unary", op: token.value, operand };
    }
    return this.parsePostfix();
  }

  /** @returns {AstNode} */
  parsePostfix() {
    let node = this.parsePrimary();
    while (this.peek().type === "op" && this.peek().value === "%") {
      this.next();
      node = { type: "postfix", op: "%", operand: node };
    }
    return node;
  }

  /** @returns {AstNode} */
  parsePrimary() {
    const token = this.peek();

    switch (token.type) {
      case "number":
        this.next();
        return { type: "number", value: token.value };
      case "string":
        this.next();
        return { type: "string", value: token.value };
      case "boolean":
        this.next();
        return { type: "boolean", value: token.value };
      case "error":
        this.next();
        return { type: "error", code: token.value };
      case "lparen": {
        this.next();
        const inner = this.parseExpression();
        this.expect("rparen", "to close parenthesised expression");
        return inner;
      }
      case "word":
        return this.parseWord();
      case "qname":
        this.next();
        return this.parsePath(/** @type {string} */ (token.value), true);
      default:
        throw new FormulaSyntaxError(
          `unexpected ${describe(token)}`,
          token.pos
        );
    }
  }

  /** @returns {AstNode} */
  parseWord() {
    const token = this.next();
    const word = /** @type {string} */ (token.value);

    // Reference or range.
    const ref = parseA1(word);
    if (ref) {
      if (this.peek().type === "colon") {
        this.next();
        const endToken = this.expect("word", "after ':' in range");
        const end = parseA1(/** @type {string} */ (endToken.value));
        if (!end) {
          throw new FormulaSyntaxError(
            `invalid range end "${endToken.value}"`,
            endToken.pos
          );
        }
        return { type: "range", start: ref, end };
      }
      return { type: "ref", ref };
    }

    // Function call.
    if (this.peek().type === "lparen") {
      return this.parseCall(word, token.pos);
    }

    // Name or path (table, section, page target).
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(word)) {
      throw new FormulaSyntaxError(`invalid name "${word}"`, token.pos);
    }
    return this.parsePath(word, false);
  }

  /**
   * Parse the rest of `segment ("!" segment)* ("!" address)?` after the first segment.
   * A lone segment stays a `name` node; anything with `!` becomes a `path` node.
   * @param {string} first
   * @param {boolean} quoted
   * @returns {AstNode}
   */
  parsePath(first, quoted) {
    /** @type {string[]} */
    const segments = [first];
    /** @type {AstNode | null} */
    let address = null;

    while (this.peek().type === "bang") {
      this.next();
      const token = this.peek();
      if (token.type === "qname") {
        this.next();
        segments.push(/** @type {string} */ (token.value));
        continue;
      }
      if (token.type !== "word") {
        throw new FormulaSyntaxError(
          `expected a name or cell after "!", found ${describe(token)}`,
          token.pos
        );
      }
      this.next();
      const word = /** @type {string} */ (token.value);
      const start = parseA1(word);
      if (start) {
        if (this.peek().type === "colon") {
          this.next();
          const endToken = this.expect("word", "after ':' in range");
          const end = parseA1(/** @type {string} */ (endToken.value));
          if (!end) {
            throw new FormulaSyntaxError(`invalid range end "${endToken.value}"`, endToken.pos);
          }
          address = { type: "range", start, end };
        } else {
          address = { type: "ref", ref: start };
        }
        if (this.peek().type === "bang") {
          throw new FormulaSyntaxError('nothing can follow a cell address after "!"', this.peek().pos);
        }
        break;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(word)) {
        throw new FormulaSyntaxError(`invalid name "${word}"`, token.pos);
      }
      segments.push(word);
    }

    if (segments.length === 1 && !address) {
      return quoted ? { type: "name", name: first, quoted: true } : { type: "name", name: first };
    }
    return { type: "path", segments, address };
  }

  /**
   * @param {string} name
   * @param {number} pos
   * @returns {AstNode}
   */
  parseCall(name, pos) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
      throw new FormulaSyntaxError(`invalid function name "${name}"`, pos);
    }
    this.expect("lparen", `after function name "${name}"`);
    /** @type {AstNode[]} */
    const args = [];

    if (this.peek().type === "rparen") {
      this.next();
      return { type: "call", name: name.toUpperCase(), args };
    }

    for (;;) {
      if (this.peek().type === "comma" || this.peek().type === "rparen") {
        // Omitted argument, e.g. IF(A1,,3).
        args.push({ type: "empty" });
      } else {
        args.push(this.parseExpression());
      }
      const token = this.peek();
      if (token.type === "comma") {
        this.next();
        continue;
      }
      if (token.type === "rparen") {
        this.next();
        break;
      }
      throw new FormulaSyntaxError(
        `expected "," or ")" in arguments to ${name}, found ${describe(token)}`,
        token.pos
      );
    }

    return { type: "call", name: name.toUpperCase(), args };
  }
}

/**
 * @param {Token} token
 * @returns {string}
 */
function describe(token) {
  if (token.type === "eof") return "end of formula";
  if (token.type === "qname") return `'${token.value}'`;
  return `"${token.value}"`;
}

/**
 * Parse formula text into an AST.
 * @param {string} input
 * @returns {AstNode}
 * @throws {FormulaSyntaxError} On malformed input.
 */
export function parseFormula(input) {
  const parser = new Parser(tokenize(input));
  const ast = parser.parseExpression();
  if (!parser.atEnd()) {
    const token = parser.peek();
    throw new FormulaSyntaxError(`unexpected ${describe(token)} after expression`, token.pos);
  }
  return ast;
}
