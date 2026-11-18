// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeQueryClient, shouldRetry } from "./query-provider";
import { ApiError, useQuery } from "./use-query";

function setup() {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe("useQuery", () => {
  it("returns data, and refetches on reload without going back to loading", async () => {
    const { wrapper } = setup();
    let n = 0;
    const fetcher = vi.fn(async () => ({ data: ++n }));
    const { result } = renderHook(() => useQuery(["/x", "site"], fetcher), { wrapper });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => result.current.reload());
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.data).toBe(2));
  });

  it("treats { data: undefined } without an error as a skipped request, not a failure", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useQuery(["/x", "skip"], async () => ({ data: undefined })), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  it("reports the API's error message", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useQuery(["/x", "err"], async () => ({ error: { message: "Project not found" }, response: new Response(null, { status: 404 }) })),
      { wrapper },
    );
    await waitFor(() => expect(result.current.error).toBe("Project not found"));
  });

  it("keeps the previous data on screen while a new key loads", async () => {
    const { wrapper } = setup();
    let release!: () => void;
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useQuery(["/x", "keep", id], () => (id === 1 ? Promise.resolve({ data: "first" }) : new Promise<{ data: string }>((r) => (release = () => r({ data: "second" }))))),
      { wrapper, initialProps: { id: 1 } },
    );
    await waitFor(() => expect(result.current.data).toBe("first"));
    rerender({ id: 2 });
    expect(result.current.data).toBe("first");
    act(() => release());
    await waitFor(() => expect(result.current.data).toBe("second"));
  });

  it("is shared between components using the same key (one request)", async () => {
    const { wrapper } = setup();
    const fetcher = vi.fn(async () => ({ data: "shared" }));
    const a = renderHook(() => useQuery(["/x", "same"], fetcher), { wrapper });
    const b = renderHook(() => useQuery(["/x", "same"], fetcher), { wrapper });
    await waitFor(() => expect(a.result.current.data).toBe("shared"));
    await waitFor(() => expect(b.result.current.data).toBe("shared"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("retry rule", () => {
  it("retries network and server errors twice but never 4xx answers", () => {
    expect(shouldRetry(0, new Error("network"))).toBe(true);
    expect(shouldRetry(1, new ApiError("boom", 503))).toBe(true);
    expect(shouldRetry(2, new ApiError("boom", 503))).toBe(false);
    expect(shouldRetry(0, new ApiError("nope", 404))).toBe(false);
    expect(shouldRetry(0, new ApiError("nope", 401))).toBe(false);
  });
});
