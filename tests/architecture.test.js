import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Which areas of `src/` each area may import from. The model says what is true (`core` <-
 * `workspace` <- feature models), `domain` composes them, `app` renders them.
 *
 * Known exception: `sheet` and `references` depend on each other (formula retargeting and
 * reference lookup are shared); `SHEET_REFERENCE_IMPORTS` pins exactly which sheet files may reach
 * into `references`, so the cycle cannot spread.
 */
const ALLOWED = {
  core: [],
  workspace: ["core"],
  document: ["core", "workspace"],
  presentation: ["core", "workspace", "document"],
  sheet: ["core", "workspace", "references"],
  references: ["core", "workspace", "document", "presentation", "sheet"],
  domain: ["core", "workspace", "document", "presentation", "sheet", "references"],
  app: ["core", "workspace", "document", "presentation", "sheet", "references", "domain"],
  persistence: ["core", "workspace", "domain"],
  main: ["core", "workspace", "domain", "app", "persistence"]
};

const SHEET_REFERENCE_IMPORTS = new Set(["sheet/cell-shift.js", "sheet/commands.js", "sheet/table-engine.js"]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : [];
  });
}

/** Static `import ... from "x"` / `export ... from "x"` specifiers that point inside the project. */
function localImports(file) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gm)) out.push(match[1]);
  for (const match of text.matchAll(/^\s*import\s+"(\.[^"]+)"/gm)) out.push(match[1]);
  return out;
}

/** Drop block and line comments so prose in docs never trips a code check. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const areaOf = (path) => {
  const parts = relative(SRC, path).split("/");
  return parts.length === 1 ? "main" : parts[0];
};

describe("architecture", () => {
  const files = walk(SRC);

  it("every area of src/ is known to this test", () => {
    const areas = new Set(files.map(areaOf));
    for (const area of areas) expect(Object.keys(ALLOWED), `unknown area "${area}"`).toContain(area);
  });

  it("imports only follow the allowed layering", () => {
    const violations = [];
    for (const file of files) {
      const from = areaOf(file);
      for (const specifier of localImports(file)) {
        const target = normalize(join(dirname(file), specifier));
        const to = areaOf(target);
        if (to === from) continue;
        if (!ALLOWED[from].includes(to)) violations.push(`${relative(SRC, file)} -> ${to} (${specifier})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("only the pinned sheet files import references", () => {
    const users = new Set();
    for (const file of files.filter((f) => areaOf(f) === "sheet")) {
      if (localImports(file).some((s) => areaOf(normalize(join(dirname(file), s))) === "references")) {
        users.add(relative(SRC, file));
      }
    }
    expect([...users].filter((f) => !SHEET_REFERENCE_IMPORTS.has(f))).toEqual([]);
  });

  it("workspace and core import nothing from the features", () => {
    for (const file of files.filter((f) => ["workspace", "core"].includes(areaOf(f)))) {
      for (const specifier of localImports(file)) {
        const to = areaOf(normalize(join(dirname(file), specifier)));
        expect(["workspace", "core"], `${relative(SRC, file)} imports ${to}`).toContain(to);
      }
    }
  });
  it("model layers do not touch the DOM, the clock of the page or browser storage", () => {
    const forbidden = [
      /\bglobalThis\b/,
      /\b(localStorage|sessionStorage|indexedDB|requestAnimationFrame)\b/,
      /\bnavigator\./,
      /\bdocument\.(create|query|body|get|add|activeElement|defaultView)/,
      /\bwindow\.(local|session|document|location|add|request|set|get)/,
      /\bnew (Mutation|Resize|Intersection)Observer\b/,
      /\bHTML\w*Element\b(?!.*@)/
    ];
    const offenders = [];
    const modelAreas = ["core", "workspace", "sheet", "document", "presentation", "references", "domain"];
    for (const file of files.filter((f) => modelAreas.includes(areaOf(f)) && !/render[\w-]*\.js$/.test(f))) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const pattern of forbidden) if (pattern.test(code)) offenders.push(`${relative(SRC, file)} matches ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });

  it("app code reads page snapshots only where it is allowed to (the list may shrink, never grow)", () => {
    // `getPage`/`getPages` deep-copy. Render paths read through `workspace/selectors.js`; these
    // editors still take a snapshot because `ensure*Content` repairs the copy in place.
    const allowed = new Map([
      ["app/block-editor.js", 2],
      ["app/sheet-editor.js", 1],
      ["app/presentation-editor.js", 1],
      ["app/slideshow.js", 1],
      ["app/demo-seed.js", 1]
    ]);
    const found = new Map();
    for (const file of files.filter((f) => areaOf(f) === "app")) {
      const count = (stripComments(readFileSync(file, "utf8")).match(/\bgetPages?\(/g) ?? []).length;
      if (count > 0) found.set(relative(SRC, file), count);
    }
    for (const [file, count] of found) {
      expect(count, `${file} reads page snapshots`).toBeLessThanOrEqual(allowed.get(file) ?? 0);
    }
  });

  it("persistence and the entry points are the only places that know about each other", () => {
    for (const file of files.filter((f) => areaOf(f) === "app")) {
      for (const specifier of localImports(file)) {
        expect(areaOf(normalize(join(dirname(file), specifier))), `${relative(SRC, file)} imports persistence`).not.toBe("persistence");
      }
    }
  });

  it("files stay under 800 lines; the oversized editors may not grow while they wait to be split", () => {
    // Ceilings, not targets: lower them as the files are split, never raise them.
    const ceilings = new Map([
      ["app/block-editor.js", 2800],
      ["app/presentation-editor.js", 2550],
      ["app/sheet-editor.js", 1550],
      ["app/ribbon-tabs.js", 1550],
      ["sheet/commands.js", 820]
    ]);
    const over = [];
    for (const file of files) {
      const name = relative(SRC, file);
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines > (ceilings.get(name) ?? 800)) over.push(`${name} has ${lines} lines`);
    }
    expect(over).toEqual([]);
  });
});
