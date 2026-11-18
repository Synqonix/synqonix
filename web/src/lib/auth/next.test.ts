import { expect, it } from "vitest";
import { safeNext } from "./next";

it("allows relative paths", () => {
  expect(safeNext("/invitations/abc")).toBe("/invitations/abc");
});

it("rejects external or malformed targets", () => {
  const bad = [
    "https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "", null, undefined,
    "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\u0000/evil.com", "/\t\t//evil.com",
  ];
  for (const b of bad) {
    expect(safeNext(b as string | null)).toBe("/dashboard");
  }
});

it("keeps path, query and hash of valid targets", () => {
  expect(safeNext("/w/1/tasks/SYN-2?tab=a#c")).toBe("/w/1/tasks/SYN-2?tab=a#c");
  expect(safeNext("/invitations/abc%2Fdef")).toBe("/invitations/abc%2Fdef");
});
