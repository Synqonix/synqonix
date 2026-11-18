import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";

describe("buildCsp", () => {
  const csp = buildCsp({ nonce: "abc123", apiUrl: "https://api.example.com" });
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("only runs scripts that carry the nonce, with no unsafe-inline or eval", () => {
    expect(directive("script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });

  it("allows the API (https and the websocket) and nothing else remote", () => {
    expect(directive("connect-src")).toBe("connect-src 'self' https://api.example.com wss://api.example.com");
    expect(directive("default-src")).toBe("default-src 'self'");
  });

  it("lets browsers upload to the configured storage origin and nowhere else", () => {
    const withStorage = buildCsp({ nonce: "n", apiUrl: "https://api.example.com", storageUrl: "https://s3.filebase.com/some/path, https://other.example.org" });
    expect(withStorage).toContain("connect-src 'self' https://api.example.com wss://api.example.com https://s3.filebase.com https://other.example.org");
    expect(csp).not.toContain("filebase");
  });

  it("blocks framing, plugins and base-tag tricks", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("uses ws:// for a plain-http API and relaxes only what development needs", () => {
    const dev = buildCsp({ nonce: "n", apiUrl: "http://localhost:4000", dev: true });
    expect(dev).toContain("ws://localhost:4000");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("lets error reports reach the Sentry origin only when a DSN is configured", () => {
    const connect = (c: string) => c.split("; ").find((d) => d.startsWith("connect-src ")) ?? "";
    const on = buildCsp({ nonce: "n", apiUrl: "https://api.example.com", sentryDsn: "https://abc@o1.ingest.sentry.io/42" });
    expect(connect(on)).toContain("https://o1.ingest.sentry.io");
    expect(connect(on)).not.toContain("abc@");
    expect(connect(buildCsp({ nonce: "n", apiUrl: "https://api.example.com" }))).not.toContain("sentry");
  });
});
