import { describe, expect, test } from "bun:test";
import {
  agentPathDepth,
  isAgentPathWithin,
  joinAgentPath,
  parseAgentPath,
  resolveAgentReference,
  resolveAgentReferenceWithAliases,
  validateAgentSegment,
} from "../runtime/agent-path.ts";

describe("canonical agent paths", () => {
  test("accepts root and strict descendants without a Pi name-length cap", () => {
    const longSegment = "a".repeat(512);
    expect(parseAgentPath("/root")).toBe("/root");
    expect(parseAgentPath("/root/worker_1/parser2")).toBe(
      "/root/worker_1/parser2",
    );
    expect(parseAgentPath(`/root/${longSegment}`)).toBe(`/root/${longSegment}`);
    expect(validateAgentSegment(longSegment)).toBe(longSegment);
    expect(joinAgentPath("/root/worker_1", "parser2")).toBe(
      "/root/worker_1/parser2",
    );
    expect(agentPathDepth("/root")).toBe(0);
    expect(agentPathDepth("/root/worker_1/parser2")).toBe(2);
  });

  test("rejects padding, false roots, trailing/empty/dotted segments, and invalid names", () => {
    for (const invalid of [
      "",
      " /root",
      "/root ",
      "/",
      "/other",
      "/other/worker",
      "/rooted",
      "/rooted/worker",
      "/root/",
      "/root//worker",
      "/root/worker/",
      "/root/./worker",
      "/root/../worker",
      "/root/root",
      "/root/Worker",
      "/root/worker-name",
      "/root/worker name",
    ])
      expect(() => parseAgentPath(invalid)).toThrow();
  });
});

describe("relative and absolute reference resolution", () => {
  test("resolves relative references beneath the caller and absolute paths exactly", () => {
    expect(resolveAgentReference("/root/caller", "worker")).toBe(
      "/root/caller/worker",
    );
    expect(resolveAgentReference("/root/caller", "worker/parser")).toBe(
      "/root/caller/worker/parser",
    );
    expect(resolveAgentReference("/root/caller", "/root/sibling")).toBe(
      "/root/sibling",
    );
    expect(resolveAgentReference("/root/caller", "/root")).toBe("/root");
  });

  test("rejects every non-canonical relative/reference form", () => {
    for (const invalid of [
      "",
      " worker",
      "worker ",
      ".",
      "..",
      "worker/",
      "worker//parser",
      "worker/./parser",
      "worker/../parser",
      "root",
      "Worker",
      "worker-name",
      "/rooted",
      "/other/worker",
    ])
      expect(() => resolveAgentReference("/root/caller", invalid)).toThrow();
  });
});

describe("opaque aliases and ambiguity", () => {
  const canonicalPaths = new Set([
    "/root",
    "/root/caller",
    "/root/caller/worker",
    "/root/sibling",
  ]);

  test("accepts opaque Pi IDs only as exact compatibility aliases", () => {
    const aliases = new Map([
      ["sa-opaque.1", "/root/sibling"],
      ["worker", "/root/caller/worker"],
    ]);
    expect(
      resolveAgentReferenceWithAliases(
        "/root/caller",
        "sa-opaque.1",
        aliases,
        canonicalPaths,
      ),
    ).toBe("/root/sibling");
    expect(
      resolveAgentReferenceWithAliases(
        "/root/caller",
        "worker",
        aliases,
        canonicalPaths,
      ),
    ).toBe("/root/caller/worker");
    expect(() =>
      resolveAgentReferenceWithAliases(
        "/root/caller",
        "sa-opaque.2",
        aliases,
        canonicalPaths,
      ),
    ).toThrow();
  });

  test("rejects alias/path ambiguity", () => {
    const aliases = new Map([["worker", "/root/sibling"]]);
    expect(() =>
      resolveAgentReferenceWithAliases(
        "/root/caller",
        "worker",
        aliases,
        canonicalPaths,
      ),
    ).toThrow("Ambiguous agent target");
  });

  test("aliases cannot bypass strict padding, slash, or dotted-reference rules", () => {
    const aliases = new Map([
      [" sa-opaque.1", "/root/sibling"],
      ["sa-opaque.1/", "/root/sibling"],
      ["worker/../sibling", "/root/sibling"],
      [".", "/root/sibling"],
    ]);
    for (const invalid of [
      " sa-opaque.1",
      "sa-opaque.1/",
      "worker/../sibling",
      ".",
    ])
      expect(() =>
        resolveAgentReferenceWithAliases(
          "/root/caller",
          invalid,
          aliases,
          canonicalPaths,
        ),
      ).toThrow();
  });
});

describe("segment-aware prefix matching", () => {
  test("matches only the same path or true descendants", () => {
    expect(isAgentPathWithin("/root/foo", "/root/foo")).toBe(true);
    expect(isAgentPathWithin("/root/foo/bar", "/root/foo")).toBe(true);
    expect(isAgentPathWithin("/root/foo2", "/root/foo")).toBe(false);
    expect(isAgentPathWithin("/root/foobar/child", "/root/foo")).toBe(false);
    expect(isAgentPathWithin("/root/foo", "/root/foo/bar")).toBe(false);
    expect(isAgentPathWithin("/root/anything", "/root")).toBe(true);
  });
});
