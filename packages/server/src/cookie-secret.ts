import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where an auto-generated cookie secret is persisted. Lives on the
 *  `/data` named volume so it survives container restarts / recreation
 *  and a single instance reuses the same secret across boots. */
export const DEFAULT_COOKIE_SECRET_FILE = "/data/cookie-secret";

/** Hardcoded placeholder used only in degraded-security local dev. */
export const DEV_COOKIE_SECRET = "orchestrator-dev-secret-change-in-production";

/** Minimum acceptable secret length. 32 chars matches the documented
 *  `openssl rand -hex 32` recipe; anything shorter is almost certainly a
 *  typo or a placeholder the operator forgot to replace. */
export const MIN_COOKIE_SECRET_LENGTH = 32;

export interface CookieSecretResult {
  secret: string;
  /** True when the dev placeholder is in use (degraded-security mode). */
  isDevFallback: boolean;
  /** True when the secret was freshly generated + persisted on this boot. */
  generated: boolean;
}

/**
 * Load a previously-persisted cookie secret from `file`, or generate a
 * strong one (`crypto.randomBytes`) and persist it there with 0600
 * permissions. Returns `null` only if the file can neither be read with a
 * usable value nor written (e.g. the volume is read-only).
 */
export function loadOrCreatePersistedCookieSecret(
  file: string,
): { secret: string; generated: boolean } | null {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= MIN_COOKIE_SECRET_LENGTH) {
      return { secret: existing, generated: false };
    }
  } catch {
    // Not found / unreadable / too short — fall through to generate.
  }
  try {
    const secret = crypto.randomBytes(32).toString("hex"); // 64 hex chars
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret + "\n", { mode: 0o600 });
    // Tighten perms even if the file pre-existed with looser ones.
    fs.chmodSync(file, 0o600);
    return { secret, generated: true };
  } catch {
    return null;
  }
}

export interface ResolveCookieSecretOptions {
  env?: NodeJS.ProcessEnv;
  /** Path the persisted secret is read from / written to. */
  file?: string;
  /** Injectable for tests; defaults to the persisting implementation. */
  loadOrCreate?: typeof loadOrCreatePersistedCookieSecret;
  /** Fatal handler; defaults to logging + `process.exit(1)`. */
  onFatal?: (message: string) => never;
}

/**
 * Cookie-secret resolution. The signed-cookie value is the entire auth
 * surface, so a missing / too-short secret can never be silently accepted.
 *
 *   - An explicit, strong `COOKIE_SECRET` (≥32 chars) always wins.
 *   - production without one: auto-generate a strong secret and persist it
 *     to the data volume (zero-touch first boot), reused on later boots.
 *     Only fatal if persistence is impossible.
 *   - non-production with a strong secret: use it.
 *   - non-production without one: refuse unless
 *     `ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET=1`, in which case use the
 *     dev placeholder AND force the loopback bind (see resolveBindHost).
 */
export function resolveCookieSecret(
  opts: ResolveCookieSecretOptions = {},
): CookieSecretResult {
  const env = opts.env ?? process.env;
  const file = opts.file ?? DEFAULT_COOKIE_SECRET_FILE;
  const loadOrCreate = opts.loadOrCreate ?? loadOrCreatePersistedCookieSecret;
  const fail: (message: string) => never =
    opts.onFatal ??
    ((message: string): never => {
      console.error(message);
      process.exit(1);
    });

  const raw = env.COOKIE_SECRET;
  const strong =
    typeof raw === "string" && raw.length >= MIN_COOKIE_SECRET_LENGTH;
  if (strong) return { secret: raw!, isDevFallback: false, generated: false };

  if (env.NODE_ENV === "production") {
    const persisted = loadOrCreate(file);
    if (persisted) {
      return {
        secret: persisted.secret,
        isDevFallback: false,
        generated: persisted.generated,
      };
    }
    return fail(
      "COOKIE_SECRET is unset and the orchestrator could not auto-generate " +
        `and persist one at ${file}. Ensure the data volume is writable, or ` +
        "set COOKIE_SECRET explicitly (openssl rand -hex 32).",
    );
  }

  if (env.ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET !== "1") {
    return fail(
      "COOKIE_SECRET is missing or too short (<32 chars). Set it to a " +
        "strong random value (openssl rand -hex 32), or set " +
        "ORCHESTRATOR_ALLOW_DEFAULT_COOKIE_SECRET=1 for local dev — the " +
        "orchestrator will then bind to 127.0.0.1 only.",
    );
  }
  return { secret: DEV_COOKIE_SECRET, isDevFallback: true, generated: false };
}
