"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input } from "@/components/ui/form";
import { errorMessage, publicApi } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";

type State =
  | { kind: "working" }
  | { kind: "ok" }
  | { kind: "password"; error?: string; busy?: boolean }
  | { kind: "error"; message: string };

function Verify() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<State>(
    token ? { kind: "working" } : { kind: "error", message: "This verification link is missing its token." },
  );
  const started = useRef(false);
  const { signIn } = useAuth();

  async function submit(password?: string) {
    const { data, error } = await publicApi.POST("/api/v1/auth/verify-email", { body: { token: token!, ...(password && { password }) } });
    if (data && "passwordRequired" in data) return setState({ kind: "password" });
    if (data) {
      signIn(data);
      return setState({ kind: "ok" });
    }
    if (password) return setState({ kind: "password", error: errorMessage(error) });
    setState({ kind: "error", message: errorMessage(error) });
  }

  useEffect(() => {
    if (!token || started.current) return; // avoid a double submit in development
    started.current = true;
    // In the browser that registered, the link applies the password chosen there and signs in.
    // Opened anywhere else, the API asks for a password instead (and the link stays unused).
    void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per link
  }, [token]);

  if (state.kind === "working") return <Alert variant="info">Verifying your email…</Alert>;
  if (state.kind === "error") {
    return (
      <Alert>
        {state.message} <Link href="/register" className="underline">Register again</Link> to get a new link.
      </Alert>
    );
  }
  if (state.kind === "password") {
    return (
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setState({ kind: "password", busy: true });
          void submit(String(new FormData(e.currentTarget).get("password")));
        }}
      >
        <p className="text-sm text-muted-foreground">
          You opened this link in a different browser from the one you registered in. Choose your password to finish.
        </p>
        {state.error && <Alert>{state.error}</Alert>}
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} autoFocus />
        </Field>
        <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Set password and continue"}</Button>
      </form>
    );
  }
  return (
    <Alert variant="success">
      Email verified, you are signed in. <Link href="/dashboard" className="underline">Continue to Synqonix</Link>
    </Alert>
  );
}

export default function VerifyEmailPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Email verification</h1>
      <Suspense>
        <Verify />
      </Suspense>
    </>
  );
}
