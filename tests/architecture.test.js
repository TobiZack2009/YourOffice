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
});
