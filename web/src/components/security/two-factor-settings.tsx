"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Card, Field, Input } from "@/components/ui/form";
import { api, errorMessage, type Schemas } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";

type Setup = Schemas["TotpSetupDto"] & { qr: string };
type Msg = { ok: boolean; text: string } | null;

/** Shows freshly issued recovery codes once, with a copy button. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <Alert variant="info">
        Save these recovery codes somewhere safe. Each one signs you in once if you lose your authenticator. They will not be shown again.
      </Alert>
      <ul aria-label="Recovery codes" className="grid w-fit grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-border bg-muted p-3 font-mono text-sm">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button type="button" onClick={onDone}>I saved them</Button>
      </div>
    </div>
  );
}

export function TwoFactorSettings() {
  const { user, setUser } = useAuth();
  const [status, setStatus] = useState<Schemas["TwoFactorStatusDto"] | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void api.GET("/api/v1/auth/2fa").then(({ data }) => setStatus(data ?? null));
  }, [version]);

  const refresh = (enabled: boolean) => {
    if (user) setUser({ ...user, twoFactorEnabled: enabled });
    setVersion((v) => v + 1);
  };

  async function start() {
    setMsg(null);
    const { data, error } = await api.POST("/api/v1/auth/2fa/setup");
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    setSetup({ ...data, qr: await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 192 }) });
  }

  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    const { data, error } = await api.POST("/api/v1/auth/2fa/enable", { body: { code } });
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    setSetup(null);
    setCodes(data.recoveryCodes);
    setMsg({ ok: true, text: "Two-factor authentication is on." });
    refresh(true);
  }

  async function disable(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const { error } = await api.POST("/api/v1/auth/2fa/disable", {
      body: { password: String(form.get("password")), code: String(form.get("code")).trim() },
    });
    if (error) return setMsg({ ok: false, text: errorMessage(error) });
    setMsg({ ok: true, text: "Two-factor authentication is off." });
    refresh(false);
  }

  async function regenerate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    const { data, error } = await api.POST("/api/v1/auth/2fa/recovery-codes", { body: { code } });
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    setCodes(data.recoveryCodes);
    setMsg(null);
    setVersion((v) => v + 1);
  }

  return (
    <Card>
      <h2 className="mb-1 font-medium">Two-factor authentication</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Ask for a code from an authenticator app (1Password, Google Authenticator, …) after your password.
      </p>
      <div className="grid max-w-md gap-4">
        {msg && <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />
        ) : status?.enabled ? (
          <>
            <p className="text-sm">
              On. {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.
            </p>
            <form onSubmit={regenerate} className="grid gap-3" aria-label="New recovery codes">
              <Field label="Authenticator code" htmlFor="regen-code" hint="Replaces all your recovery codes.">
                <Input id="regen-code" name="code" autoComplete="one-time-code" inputMode="numeric" required pattern="\s*\d{6}\s*" />
              </Field>
              <Button type="submit" variant="outline" className="w-fit">New recovery codes</Button>
            </form>
            <form onSubmit={disable} className="grid gap-3 border-t border-border pt-4" aria-label="Turn off two-factor authentication">
              <Field label="Password" htmlFor="tfa-password">
                <Input id="tfa-password" name="password" type="password" autoComplete="current-password" required />
              </Field>
              <Field label="Authenticator or recovery code" htmlFor="tfa-code">
                <Input id="tfa-code" name="code" autoComplete="one-time-code" required maxLength={20} />
              </Field>
              <Button type="submit" variant="outline" className="w-fit">Turn off</Button>
            </form>
          </>
        ) : setup ? (
          <form onSubmit={confirm} className="grid gap-3">
            <p className="text-sm">Scan this code with your authenticator app, then enter the six-digit code it shows.</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- a generated data: URL, nothing to optimise */}
            <img src={setup.qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded-md border border-border bg-white" />
            <p className="text-xs text-muted-foreground">
              Can&apos;t scan? Enter this key: <code className="break-all font-mono">{setup.secret}</code>
            </p>
            <Field label="Code from the app" htmlFor="setup-code">
              <Input id="setup-code" name="code" autoComplete="one-time-code" inputMode="numeric" required pattern="\s*\d{6}\s*" autoFocus />
            </Field>
            <div className="flex gap-2">
              <Button type="submit">Turn on</Button>
              <Button type="button" variant="outline" onClick={() => setSetup(null)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <Button type="button" className="w-fit" onClick={() => void start()} disabled={!status}>Set up two-factor authentication</Button>
        )}
      </div>
    </Card>
  );
}
