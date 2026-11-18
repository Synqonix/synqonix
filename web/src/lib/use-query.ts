"use client";

import { keepPreviousData, useQuery as useTanstackQuery, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";
import { errorMessage } from "@/lib/api/client";

/** What the typed API client returns (openapi-fetch), or a fetcher that skips the request. */
type Result<T> = { data?: T; error?: unknown; response?: Response };

/** A failed request; `status` lets the query client skip retries for 4xx answers. */
export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Data fetching for the typed API client, on TanStack Query: results are cached per `key`, shown
 * again instantly when a page is revisited, deduplicated, retried on network and server errors,
 * and refreshed when the window regains focus.
 *
 * `key` starts with the endpoint path (so `invalidateQueries({ queryKey: [path] })` refreshes every
 * view of it) and must include everything the fetcher depends on. While a new key loads, the
 * previous data stays on screen; `reload()` refetches without flashing the loading state.
 * A fetcher may return `{ data: undefined }` without an error to skip the request.
 */
export function useQuery<T>(key: QueryKey, fetcher: () => Promise<Result<T>>) {
  const query = useTanstackQuery({
    queryKey: key,
    queryFn: async (): Promise<T | null> => {
      const res = await fetcher();
      if (res.data !== undefined) return res.data;
      if (res.error === undefined) return null; // skipped
      throw new ApiError(errorMessage(res.error), res.response?.status);
    },
    placeholderData: keepPreviousData,
  });
  const { refetch } = query;
  const reload = useCallback(() => void refetch(), [refetch]);
  return {
    data: (query.data ?? undefined) as T | undefined,
    error: query.error ? query.error.message : undefined,
    loading: query.isPending,
    reload,
  };
}
