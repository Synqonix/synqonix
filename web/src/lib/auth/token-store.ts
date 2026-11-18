import type { Schemas } from "@/lib/api/client";

type AuthResponse = Schemas["AuthResponseDto"];
type Listener = (auth: AuthResponse | null) => void;
/** `refreshToken` only exists in values stored by older versions; it is sent once to move the session to the cookie. */
interface Stored { accessToken: string; refreshToken?: string }

/**
 * The short-lived access token is kept in localStorage so reloads and other tabs reuse it.
 * The long-lived refresh token never reaches JavaScript: the API keeps it in an httpOnly cookie,
 * so an XSS bug can at worst use a token that expires within minutes. The app must still stay
 * free of XSS (no dangerouslySetInnerHTML with user content, strict CSP, vetted dependencies).
 */
const KEY = "sx_auth";
const LOCK = "sx-token-refresh";
const listeners = new Set<Listener>();
let memory: Stored | null = null; // fallback when localStorage is unavailable
let inflight: Promise<string | null> | null = null;

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return memory;
  }
}

function write(value: Stored | null) {
  memory = value;
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the in-memory copy is used */
  }
}

/** Runs `fn` exclusively across tabs so concurrent refreshes cannot reuse a rotated token. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(LOCK, fn);
  }
  return fn();
}

export const tokenStore = {
  get: () => read()?.accessToken ?? null,
  hasSession: () => read() !== null,
  /** Stores the access token from a login/register/refresh response (or clears it with null). */
  set(auth: Pick<AuthResponse, "accessToken"> | null) {
    write(auth ? { accessToken: auth.accessToken } : null);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Called when another tab changes the stored session (sign-in, sign-out, refresh). */
  onExternalChange(cb: () => void) {
    const handler = (e: StorageEvent) => e.key === KEY && cb();
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  },
  /**
   * Gets a new access token using the refresh cookie. Concurrent callers (and other tabs) share
   * one request: if another caller already refreshed while we waited, we reuse its result.
   */
  refresh(): Promise<string | null> {
    const before = read();
    if (!before) return Promise.resolve(null);
    inflight ??= exclusive(async () => {
      try {
        const current = read();
        if (!current) return null;
        if (current.accessToken !== before.accessToken) return current.accessToken; // refreshed elsewhere
        const { publicApi } = await import("@/lib/api/client");
        const { data, error, response } = await publicApi.POST("/api/v1/auth/refresh", {
          // Sessions stored by older versions still hold the refresh token: send it once, the
          // response moves it into the cookie and it is never stored here again.
          body: current.refreshToken ? { refreshToken: current.refreshToken } : {},
        });
        if (data) {
          write({ accessToken: data.accessToken });
          listeners.forEach((l) => l(data));
          return data.accessToken;
        }
        // Only a definitive rejection ends the session; network errors keep it for a retry.
        const status: number = response.status;
        if (error && (status === 401 || status === 400)) {
          write(null);
          listeners.forEach((l) => l(null));
        }
        return null;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    });
    return inflight;
  },
};
