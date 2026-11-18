"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "./use-query";

/** Retries network and server failures twice; a 4xx answer will not change by asking again. */
export const shouldRetry = (failures: number, error: unknown) =>
  failures < 2 && !(error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500);

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, refetchOnWindowFocus: true },
    },
  });
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // One client per browser tab (not shared between requests on the server).
  const [client] = useState(makeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
