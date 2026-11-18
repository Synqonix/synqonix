// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("@/lib/api/client", () => ({ publicApi: { POST: (...a: unknown[]) => post(...a) } }));

import { tokenStore } from "./token-store";

const ok = (n: number) => ({
  data: { accessToken: `a${n}`, user: { id: "1" } },
  response: { status: 200 },
});

beforeEach(() => {
  post.mockReset();
  localStorage.clear();
  tokenStore.set(null);
});

it("persists only the access token in localStorage", () => {
  // Even if a response carried a refresh token, it must never be written where scripts can read it.
  tokenStore.set({ accessToken: "a", refreshToken: "r" } as { accessToken: string });
  expect(JSON.parse(localStorage.getItem("sx_auth")!)).toEqual({ accessToken: "a" });
  expect(tokenStore.get()).toBe("a");
  tokenStore.set(null);
  expect(localStorage.getItem("sx_auth")).toBeNull();
});

it("does nothing without a stored session", async () => {
  expect(await tokenStore.refresh()).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it("shares one cookie-based refresh between concurrent callers and stores the new access token", async () => {
  tokenStore.set({ accessToken: "a0" });
  post.mockResolvedValue(ok(1));
  const [x, y] = await Promise.all([tokenStore.refresh(), tokenStore.refresh()]);
  expect([x, y]).toEqual(["a1", "a1"]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0][1]).toEqual({ body: {} });
  expect(JSON.parse(localStorage.getItem("sx_auth")!)).toEqual({ accessToken: "a1" });
});

it("sends a refresh token left by an older version once, then forgets it", async () => {
  localStorage.setItem("sx_auth", JSON.stringify({ accessToken: "a0", refreshToken: "legacy" }));
  post.mockResolvedValue(ok(1));
  expect(await tokenStore.refresh()).toBe("a1");
  expect(post.mock.calls[0][1]).toEqual({ body: { refreshToken: "legacy" } });
  expect(JSON.parse(localStorage.getItem("sx_auth")!)).toEqual({ accessToken: "a1" });
});

it("clears the session when the refresh token is rejected", async () => {
  tokenStore.set({ accessToken: "a0" });
  post.mockResolvedValue({ data: undefined, error: { message: "bad" }, response: { status: 401 } });
  const seen = vi.fn();
  const off = tokenStore.subscribe(seen);
  expect(await tokenStore.refresh()).toBeNull();
  expect(tokenStore.hasSession()).toBe(false);
  expect(seen).toHaveBeenCalledWith(null);
  off();
});

it("keeps the session on server errors so it can retry", async () => {
  tokenStore.set({ accessToken: "a0" });
  post.mockResolvedValue({ data: undefined, error: { message: "boom" }, response: { status: 500 } });
  expect(await tokenStore.refresh()).toBeNull();
  expect(tokenStore.hasSession()).toBe(true);
});
