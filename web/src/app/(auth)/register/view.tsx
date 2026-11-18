"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, Input } from "@/components/ui/form";
import { useAuth } from "@/lib/auth/auth-context";
import { useRedirectIfAuthenticated } from "@/lib/auth/use-redirect-if-authenticated";

function RegisterForm() {
  const next = useRedirectIfAuthenticated();
  const params = useSearchParams();
  const nextParam = params.get("next");
  const { register } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Coming from an invitation link: the invitation proves the email, so no verification step.
  const invitationToken = /^\/invitations\/([^/?#]+)/.exec(next)?.[1];

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const email = String(form.get("email"));
    try {
      const result = await register({
        name: String(form.get("name")),
        email,
        password: String(form.get("password")),
        ...(invitationToken && { invitationToken: decodeURIComponent(invitationToken) }),
      });
      if (result === "signedIn") router.replace(next);
      else setSentTo(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Check your inbox</h1>
        <Alert variant="success">
          We sent a link to <strong>{sentTo}</strong>. Open it within 24 hours to finish creating your account; it signs you in.
        </Alert>
        <p className="text-sm text-muted-foreground">
          No email? Check your spam folder, or <button type="button" className="text-foreground underline" onClick={() => { setSentTo(null); setBusy(false); }}>try again</button>.
        </p>
      </>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground">Start managing projects like a developer.</p>
      </div>
      <form onSubmit={onSubmit} className="grid gap-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Name" htmlFor="name">
          <Input id="name" name="name" autoComplete="name" required maxLength={100} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={params.get("email") ?? ""} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Already have an account? <Link href={nextParam ? `/login?next=${encodeURIComponent(next)}` : "/login"} className="text-foreground underline">Sign in</Link>
      </p>
    </>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
