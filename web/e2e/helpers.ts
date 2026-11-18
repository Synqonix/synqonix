import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHmac } from "node:crypto";

export const API = (process.env.E2E_API_URL ?? "http://localhost:4000") + "/api/v1";
export const PASSWORD = "correct horse battery 9";

export async function api<T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(API + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Dev-Remail receives the API's email in development and CI (Resend-compatible API; docker-compose.dev.yml, the CI job's service). */
export const MAIL_URL = process.env.E2E_MAIL_URL ?? "http://localhost:6245";

/** The newest link to `path` (e.g. "/verify-email") emailed to `to`, waiting for the mail to arrive. */
export async function emailedLink(to: string, path: string): Promise<string> {
  const get = async <T>(p: string) => (await (await fetch(`${MAIL_URL}${p}`, { headers: { authorization: "Bearer re_dev" } })).json()) as T;
  const pattern = new RegExp(`https?://\\S*${path}\\?token=[^\\s"<]+`);
  for (let i = 0; i < 50; i++) {
    const { data } = await get<{ data: { id: string; to: string[]; created_at: string }[] }>("/emails?limit=100");
    const mine = data.filter((e) => e.to.includes(to)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const e of mine) {
      const link = pattern.exec((await get<{ text: string }>(`/emails/${e.id}`)).text)?.[0];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No ${path} link emailed to ${to} (is Dev-Remail running at ${MAIL_URL}?)`);
}

export const uniqueEmail = (tag: string) => `${tag}.${Date.now()}.${Math.floor(Math.random() * 1e4)}@example.com`;

/** A user with a workspace, a Scrum project and a few tasks, created through the API. */
export async function seed(tag: string) {
  const email = uniqueEmail(tag);
  await api("/auth/register", { body: { email, name: "E2E User", password: PASSWORD } });
  const link = new URL(await emailedLink(email, "/verify-email"));
  // No registration cookie on this side, so the link sets the password (as on another device).
  const session = await api<{ accessToken: string; user: { id: string } }>("/auth/verify-email", { body: { token: link.searchParams.get("token"), password: PASSWORD } });
  const token = session.accessToken;
  const ws = await api<{ id: string }>("/workspaces", { token, body: { name: `E2E ${tag}` } });
  const project = await api<{ id: string }>(`/workspaces/${ws.id}/projects`, { token, body: { name: "Checkout", key: "CHK", template: "SCRUM" } });
  const tasks: { key: string; id: string }[] = [];
  for (const title of ["Fix the payment form", "Add order history"]) {
    tasks.push(await api(`/workspaces/${ws.id}/projects/${project.id}/tasks`, { token, body: { title, type: "TASK" } }));
  }
  return { email, token, workspaceId: ws.id, projectId: project.id, tasks };
}

export async function logIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Fails on serious or critical accessibility violations (colour contrast, missing names, bad ARIA, …). */
export async function expectAccessible(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`), "accessibility violations").toEqual([]);
}

/** Authenticator-app code (RFC 6238) for a base32 secret, `offset` steps of 30 s from now. */
export function totp(secret: string, offset = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac("sha1", key).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
