import { describe, expect, it } from "vitest";
import { isSafeUrl } from "../src/core/url.js";

describe("isSafeUrl", () => {
  it("accepts web, mail, phone, page and relative addresses", () => {
    for (const url of ["https://a.test/x?y=1", "http://a.test", "mailto:me@a.test", "tel:+15550100", "#sheet_abc", "/path", "../x", "page.html", "a/b:c"]) {
      expect(isSafeUrl(url), url).toBe(true);
    }
  });

  it("rejects script-bearing schemes however they are dressed", () => {
    for (const url of ["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:x", "java\tscript:x", "java\nscript:x", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "\u0001javascript:x"]) {
      expect(isSafeUrl(url), JSON.stringify(url)).toBe(false);
    }
  });

  it("rejects empty and non-string values", () => {
    for (const url of ["", "   ", null, undefined, 3]) expect(isSafeUrl(url)).toBe(false);
  });
});
