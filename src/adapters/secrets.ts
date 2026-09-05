import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// User-level secret store bridge for Layer 2 (browser) flows.
//
// Layout (outside the repository, outside RADAR_HOME so test homes never
// mix with real credentials):
//   ~/.config/short-drama-radar/secrets/<credentialRef>.json  — Playwright
//     storageState export ({ cookies: [...], origins: [...] })
//   ~/.config/short-drama-radar/secrets/<proxyRef>.json       —
//     { server: "http://host:port", username?: string, password?: string }
//
// Files MUST be mode 0600. Contents NEVER enter logs, evidence, stdout,
// errors or the DB — errors below reference the opaque ref and path only.

export interface SecretStore {
  root: string;
  /** Resolve a credentialRef to a Playwright storageState object, or null when absent. */
  credential(ref: string): { storageState: unknown } | null;
  /** Resolve a proxyRef to launch options, or null when absent. */
  proxy(ref: string): { server: string; username?: string; password?: string } | null;
}

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

export function secretsRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? (process.env.HOME ? join(process.env.HOME, ".config") : null);
  if (!xdg) throw new SecretsError("cannot locate a config root: neither XDG_CONFIG_HOME nor HOME is set");
  return process.env.RADAR_SECRETS_DIR ?? join(xdg, "short-drama-radar", "secrets");
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new SecretsError(`secret file is not valid JSON: ${path} (re-export it; contents are never logged)`);
  }
}

function assertTightPermissions(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new SecretsError(`secret file permissions too loose: ${path} — run chmod 600`);
    }
  } catch (err) {
    if (err instanceof SecretsError) throw err;
    // stat failures surface as "absent" to the caller
  }
}

export function openSecretStore(root = secretsRoot()): SecretStore {
  return {
    root,
    credential(ref: string) {
      const path = join(root, `${ref}.json`);
      const json = readJson(path);
      if (!json) return null;
      assertTightPermissions(path);
      if (typeof json["cookies"] !== "object" || json["cookies"] === null) {
        throw new SecretsError(`credential file ${path} is not a Playwright storageState export (no cookies array; re-export via context.storageState())`);
      }
      return { storageState: json };
    },
    proxy(ref: string) {
      const path = join(root, `${ref}.json`);
      const json = readJson(path);
      if (!json) return null;
      assertTightPermissions(path);
      const server = json["server"];
      if (typeof server !== "string" || !/^https?:\/\//.test(server)) {
        throw new SecretsError(`proxy file ${path} must carry a { server: "http(s)://host:port", ... } object (contents are never logged)`);
      }
      const out: { server: string; username?: string; password?: string } = { server };
      if (typeof json["username"] === "string") out.username = json["username"];
      if (typeof json["password"] === "string") out.password = json["password"];
      return out;
    },
  };
}
