"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, publicApi, type Schemas } from "@/lib/api/client";
import { tokenStore } from "./token-store";

type User = Schemas["UserDto"];
type Status = "loading" | "authenticated" | "anonymous" | "error";

type Session = Schemas["AuthResponseDto"];
/** What a password sign-in led to: a session, or a request for the 2FA code. */
export type LoginOutcome = { kind: "signedIn" } | { kind: "mfa"; mfaToken: string };

interface AuthContextValue {
  user: User | null;
  status: Status;
  login(email: string, password: string): Promise<LoginOutcome>;
  /** Second step of a 2FA sign-in: an authenticator code or a recovery code. */
  completeLogin(mfaToken: string, code: string): Promise<void>;
  /** "verificationSent" means the account is finished through the emailed link; an invitation link signs in at once. */
  register(input: { email: string; name: string; password: string; invitationToken?: string }): Promise<"verificationSent" | "signedIn">;
  /** Starts a session the API already issued (e.g. by an email verification link). */
  signIn(session: Session): void;
  logout(): Promise<void>;
  setUser(user: User): void;
  /** Re-checks the stored session (e.g. after a transient network failure). */
  retry(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const restoreRef = useRef<() => void>(() => {});

  const queryClient = useQueryClient();
  const apply = useCallback((auth: Schemas["AuthResponseDto"] | null) => {
    // Nothing fetched for one account may be shown to the next.
    if (!auth) queryClient.clear();
    tokenStore.set(auth);
    setUser(auth?.user ?? null);
    setStatus(auth ? "authenticated" : "anonymous");
  }, [queryClient]);

  // Restore the session from the stored tokens on first load; follow later refresh failures
  // and sign-ins/outs performed in other tabs.
  useEffect(() => {
    const restore = async () => {
      if (!tokenStore.hasSession()) return setStatus("anonymous");
      // The API client refreshes an expired access token and replays the request.
      const { data } = await api.GET("/api/v1/users/me").catch(() => ({ data: undefined }));
      if (data) {
        setUser(data);
        setStatus("authenticated");
      } else {
        // Tokens cleared => the session really ended. Otherwise it was a transient failure.
        setStatus(tokenStore.hasSession() ? "error" : "anonymous");
      }
    };
    restoreRef.current = () => {
      setStatus("loading");
      void restore();
    };
    void restore();
    const off = tokenStore.subscribe(apply);
    const offTabs = tokenStore.onExternalChange(() =>
      tokenStore.hasSession() ? void restore() : apply(null),
    );
    return () => {
      off();
      offTabs();
    };
  }, [apply]);

  const login = useCallback<AuthContextValue["login"]>(async (email, password) => {
    const { data, error } = await publicApi.POST("/api/v1/auth/login", { body: { email, password } });
    if (!data) throw new Error(errorMessage(error, "Invalid email or password"));
    if ("mfaRequired" in data) return { kind: "mfa", mfaToken: data.mfaToken };
    apply(data);
    return { kind: "signedIn" };
  }, [apply]);

  const completeLogin = useCallback<AuthContextValue["completeLogin"]>(async (mfaToken, code) => {
    const { data, error } = await publicApi.POST("/api/v1/auth/login/2fa", { body: { mfaToken, code } });
    if (!data) throw new Error(errorMessage(error, "That code is not valid"));
    apply(data);
  }, [apply]);

  const register = useCallback<AuthContextValue["register"]>(async (input) => {
    const { data, error } = await publicApi.POST("/api/v1/auth/register", { body: input });
    if (!data) throw new Error(errorMessage(error));
    if ("verificationSent" in data) return "verificationSent";
    apply(data);
    return "signedIn";
  }, [apply]);

  const logout = useCallback(async () => {
    apply(null);
    // The refresh cookie identifies the session; the API revokes it and clears the cookie.
    await publicApi.POST("/api/v1/auth/logout", { body: {} }).catch(() => undefined);
  }, [apply]);

  const value = useMemo(
    () => ({ user, status, login, completeLogin, register, signIn: apply, logout, setUser, retry: () => restoreRef.current() }),
    [user, status, login, completeLogin, register, apply, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
