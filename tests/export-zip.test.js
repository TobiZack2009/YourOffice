import { describe, expect, it } from "vitest";
import { utf8 } from "../src/export/encode.js";
import { crc32, createZip, readZip } from "../src/export/zip.js";

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });

  it("is zero-based for empty input", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("createZip / readZip", () => {
  it("round-trips paths and bytes", () => {
    const files = [
      { path: "index.html", data: utf8("<p>hi</p>") },
      { path: "sub/日本語.md", data: utf8("# 日本語\n") },
      { path: "empty.txt", data: new Uint8Array() },
      { path: "binary.bin", data: Uint8Array.from({ length: 300 }, (_, i) => i % 256) }
    ];
    const entries = readZip(createZip(files));
    expect(entries.map((e) => e.path)).toEqual(files.map((f) => f.path));
    entries.forEach((entry, i) => expect([...entry.data]).toEqual([...files[i].data]));
  });

  it("starts with the local file signature and ends with the directory record", () => {
    const zip = createZip([{ path: "a.txt", data: utf8("a") }]);
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(zip.length).toBeGreaterThan(22);
    expect(new DataView(zip.buffer, zip.byteOffset).getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });

  it("flags UTF-8 names", () => {
    const zip = createZip([{ path: "é.txt", data: utf8("x") }]);
    expect(new DataView(zip.buffer, zip.byteOffset).getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it("rejects bytes that are not an archive", () => {
    expect(() => readZip(utf8("not a zip file at all, definitely not"))).toThrow();
  });
});
