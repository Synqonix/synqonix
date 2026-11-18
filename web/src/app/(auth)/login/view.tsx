"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input } from "@/components/ui/form";
import { useAuth } from "@/lib/auth/auth-context";
import { useRedirectIfAuthenticated } from "@/lib/auth/use-redirect-if-authenticated";

function LoginForm() {
  const next = useRedirectIfAuthenticated();
  const nextParam = useSearchParams().get("next");
  const { login, completeLogin } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once the password was accepted and the account asks for a 2FA code. */
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }

  function onPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const outcome = await login(String(form.get("email")), String(form.get("password")));
      if (outcome.kind === "mfa") {
        setMfaToken(outcome.mfaToken);
        setBusy(false);
      } else {
        router.replace(next);
      }
    });
  }

  function onCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    void run(async () => {
      await completeLogin(mfaToken!, code);
      router.replace(next);
    });
  }

  if (mfaToken) {
    return (
      <>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Two-factor authentication</h1>
          <p className="text-sm text-muted-foreground">Enter the six-digit code from your authenticator app.</p>
        </div>
        <form onSubmit={onCode} className="grid gap-4">
          {error && <Alert>{error}</Alert>}
          <Field label="Code" htmlFor="code" hint="Lost your device? Enter one of your recovery codes instead.">
            <Input id="code" name="code" autoComplete="one-time-code" inputMode="text" required maxLength={20} autoFocus />
          </Field>
          <Button type="submit" disabled={busy}>{busy ? "Checking…" : "Verify"}</Button>
        </form>
        <button type="button" className="text-left text-sm text-muted-foreground hover:text-foreground" onClick={() => { setMfaToken(null); setError(null); }}>
          Start over
        </button>
      </>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted-foreground">Sign in to your workspace.</p>
      </div>
      <form onSubmit={onPassword} className="grid gap-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="flex justify-between text-sm text-muted-foreground">
        <Link href="/forgot-password" className="hover:text-foreground">Forgot password?</Link>
        <Link href={nextParam ? `/register?next=${encodeURIComponent(next)}` : "/register"} className="hover:text-foreground">Create account</Link>
      </div>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
