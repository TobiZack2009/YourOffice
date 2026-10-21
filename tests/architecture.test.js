import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Which areas of `src/` each area may import from. The model says what is true (`core` <-
 * `workspace` <- feature models), `domain` composes them, `app` renders them. `calc` is the
 * formula language and the table value model: it knows nothing about pages or references.
 */
const ALLOWED = {
  core: [],
  calc: ["core"],
  workspace: ["core"],
  document: ["core", "workspace"],
  presentation: ["core", "workspace", "document"],
  sheet: ["core", "workspace", "calc", "references"],
  references: ["core", "workspace", "calc", "document", "presentation"],
  domain: ["core", "workspace", "calc", "document", "presentation", "sheet", "references"],
  export: ["core", "workspace", "calc", "document", "presentation", "sheet", "references"],
  app: ["core", "workspace", "calc", "document", "presentation", "sheet", "references", "domain", "export"],
  persistence: ["core", "workspace", "domain"],
  styles: [],
  main: ["core", "workspace", "domain", "app", "persistence", "styles"]
};

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
    const modelAreas = ["core", "calc", "workspace", "sheet", "document", "presentation", "references", "domain", "export"];
    for (const file of files.filter((f) => modelAreas.includes(areaOf(f)) && !/render[\w-]*\.js$/.test(f))) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const pattern of forbidden) if (pattern.test(code)) offenders.push(`${relative(SRC, file)} matches ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });

  it("app code reads page snapshots only where it is allowed to (the list may shrink, never grow)", () => {
    // `getPage`/`getPages` deep-copy. App code reads through `workspace/selectors.js`; the only
    // `getPage(` left is the nested store's own definition of the store-shaped method.
    const allowed = new Map([["app/nested-store.js", 1]]);
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

  it("files stay under 800 lines; the few oversized files may not grow while they wait to be split", () => {
    // Ceilings, not targets: lower them as the files are split, never raise them.
    const ceilings = new Map([
      ["app/block-editor.js", 820],
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

  describe("styles", () => {
    const STYLES = join(SRC, "styles");
    const cssFiles = (dir) =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? cssFiles(path) : path.endsWith(".css") ? [path] : [];
      });
    const all = cssFiles(STYLES);
    const importsOf = (file) =>
      [...readFileSync(file, "utf8").matchAll(/@import\s+"([^"]+)"/g)].map((m) => normalize(join(dirname(file), m[1])));

    it("the app imports exactly one stylesheet, src/styles/index.css", () => {
      const sheets = [];
      for (const file of [...files, join(SRC, "..", "index.html")]) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/import\s+["']([^"']+\.css)["']/g)) sheets.push(`${relative(SRC, file)} -> ${m[1]}`);
      }
      expect(sheets).toEqual(["main.js -> ./styles/index.css"]);
    });

    it("index.css only imports, and every stylesheet is reached from it exactly once", () => {
      const index = join(STYLES, "index.css");
      expect(readFileSync(index, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import\s+"[^"]+";/g, "").trim()).toBe("");
      const imported = importsOf(index);
      expect(new Set(imported).size, "a stylesheet is imported twice").toBe(imported.length);
      expect(imported.sort()).toEqual(all.filter((f) => f !== index).sort());
      for (const file of all.filter((f) => f !== index)) expect(importsOf(file), `${relative(SRC, file)} imports`).toEqual([]);
    });

    /** Classes in the first compound of each top-level selector: the ones a file defines (owns). */
    const ownedClasses = (file) => {
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const owned = new Set();
      let depth = 0;
      let selector = "";
      for (const ch of text) {
        if (ch === "{") {
          if (depth === 0 && !selector.trim().startsWith("@")) {
            for (const part of selector.split(",")) {
              const first = part.trim().split(/[\s>+~]/)[0];
              for (const m of first.matchAll(/\.([A-Za-z_][\w-]*)/g)) owned.add(m[1]);
            }
          }
          depth += 1;
          selector = "";
        } else if (ch === "}") {
          depth -= 1;
          selector = "";
        } else if (ch === ";") {
          selector = "";
        } else if (depth === 0) {
          selector += ch;
        }
      }
      return owned;
    };

    it("a class is styled at the top level of one stylesheet only; other areas style it from inside their own", () => {
      const owners = new Map();
      for (const file of all.filter((f) => !f.endsWith("index.css"))) {
        for (const name of ownedClasses(file)) owners.set(name, [...(owners.get(name) ?? []), relative(STYLES, file)]);
      }
      const shared = [...owners].filter(([, files]) => files.length > 1).map(([name, files]) => `.${name}: ${files.join(", ")}`);
      expect(shared).toEqual([]);
    });

    it("stylesheets stay under 400 lines", () => {
      const over = all.filter((f) => readFileSync(f, "utf8").split("\n").length > 400).map((f) => relative(SRC, f));
      expect(over).toEqual([]);
    });
  });
});
