import { describe, expect, test } from "bun:test";

describe("test runner environment", () => {
  test("strips every inherited PI_SUBAGENT_* control variable", () => {
    expect(
      Object.keys(process.env)
        .filter((name) => name.startsWith("PI_SUBAGENT_"))
        .sort(),
    ).toEqual([]);
  });
});
