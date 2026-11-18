"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TwoFactorSettings } from "@/components/security/two-factor-settings";
import { Alert, Badge, Card, Field, Input, Select } from "@/components/ui/form";
import { api, API_URL, errorMessage, type Schemas } from "@/lib/api/client";

type Msg = { ok: boolean; text: string } | null;

function ChangePassword() {
  const [msg, setMsg] = useState<Msg>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const { error } = await api.POST("/api/v1/auth/change-password", {
      body: { currentPassword: String(data.get("current")), newPassword: String(data.get("next")) },
    });
    if (error) return setMsg({ ok: false, text: errorMessage(error) });
    form.reset();
    setMsg({ ok: true, text: "Password changed. Other devices were signed out." });
  }

  return (
    <Card>
      <h2 className="mb-4 font-medium">Change password</h2>
      <form onSubmit={onSubmit} className="grid max-w-sm gap-4">
        {msg && <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert>}
        <Field label="Current password" htmlFor="current">
          <Input id="current" name="current" type="password" autoComplete="current-password" required />
        </Field>
        <Field label="New password" htmlFor="next">
          <Input id="next" name="next" type="password" autoComplete="new-password" required minLength={8} maxLength={128} />
        </Field>
        <Button type="submit" className="w-fit">Update password</Button>
      </form>
    </Card>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<Schemas["SessionDto"][]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    void api.GET("/api/v1/auth/sessions").then(({ data }) => setSessions(data ?? []));
  }, [version]);

  async function revoke(id: string) {
    await api.DELETE("/api/v1/auth/sessions/{id}", { params: { path: { id } } });
    setVersion((v) => v + 1);
  }

  return (
    <Card>
      <h2 className="mb-4 font-medium">Active sessions</h2>
      <ul className="divide-y divide-border">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="truncate">{s.userAgent ?? "Unknown device"}{s.current && " (this device)"}</p>
              <p className="text-xs text-muted-foreground">
                {s.ip ?? "unknown IP"} · last active {new Date(s.lastUsedAt).toLocaleString()}
              </p>
            </div>
            {!s.current && <Button size="sm" variant="outline" onClick={() => void revoke(s.id)}>Revoke</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ApiTokens() {
  const [tokens, setTokens] = useState<Schemas["ApiTokenDto"][]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<Schemas["WorkspaceDto"][]>([]);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  useEffect(() => {
    void api.GET("/api/v1/api-tokens").then(({ data }) => setTokens(data ?? []));
  }, [version]);
  useEffect(() => {
    void api.GET("/api/v1/workspaces").then(({ data }) => setWorkspaces(data ?? []));
  }, []);
  const workspaceName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "one workspace";

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get("name"));
    const access = String(fields.get("access"));
    const workspaceId = String(fields.get("workspace") || "");
    const { data, error } = await api.POST("/api/v1/api-tokens", {
      body: { name, scopes: access === "read" ? ["read"] : ["read", "write"], ...(workspaceId && { workspaceId }) },
    });
    if (!data) return setError(errorMessage(error));
    setError(null);
    setCreated(data.token);
    form.reset();
    reload();
  }

  async function revoke(id: string) {
    await api.DELETE("/api/v1/api-tokens/{id}", { params: { path: { id } } });
    reload();
  }

  return (
    <Card>
      <h2 className="mb-1 font-medium">Personal API tokens</h2>
      <p className="mb-4 text-sm text-muted-foreground">Use a token to sign in to the VS Code extension or to call the API (<a href={`${API_URL}/docs`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">API reference</a>).</p>
      {error && <Alert>{error}</Alert>}
      {created && (
        <div className="mb-4">
          <Alert variant="success">
            Copy your new token now — it will not be shown again.
            <code className="mt-2 block break-all rounded bg-background p-2 font-mono text-xs">{created}</code>
          </Alert>
        </div>
      )}
      <form onSubmit={onCreate} className="mb-4 grid max-w-lg gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <Input name="name" placeholder="Token name, e.g. VS Code" required maxLength={60} aria-label="Token name" />
        <Select name="access" aria-label="Token access" defaultValue="write">
          <option value="write">Read &amp; write</option>
          <option value="read">Read only</option>
        </Select>
        <Select name="workspace" aria-label="Token workspace" defaultValue="">
          <option value="">All workspaces</option>
          {workspaces.map((w) => <option key={w.id} value={w.id}>Only {w.name}</option>)}
        </Select>
        <Button type="submit">Create</Button>
      </form>
      <ul className="divide-y divide-border">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-4 py-3 text-sm">
            <div>
              <p className="flex flex-wrap items-center gap-2">
                {t.name} <span className="font-mono text-xs text-muted-foreground">{t.prefix}…</span>
                <Badge>{t.scopes.includes("write") ? "Read & write" : "Read only"}</Badge>
                {t.workspaceId && <Badge>Only {workspaceName(t.workspaceId)}</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">
                {t.lastUsedAt ? `Last used ${new Date(t.lastUsedAt).toLocaleString()}` : "Never used"}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => void revoke(t.id)}>Revoke</Button>
          </li>
        ))}
        {tokens.length === 0 && <li className="py-3 text-sm text-muted-foreground">No tokens yet.</li>}
      </ul>
    </Card>
  );
}

export default function SecurityPage() {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
      <ChangePassword />
      <TwoFactorSettings />
      <Sessions />
      <ApiTokens />
    </div>
  );
}
