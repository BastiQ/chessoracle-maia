import { createHash, timingSafeEqual } from "node:crypto";

export type AuthResult = "ok" | "unauthorized" | "unconfigured";

/**
 * Timing-safe check of `Authorization: Bearer <token>` against
 * `MAIA_SERVICE_TOKEN`. Both sides are hashed first so the comparison runs over
 * equal-length buffers and leaks neither the token nor its length. Fails closed:
 * with no token configured, nobody is let in.
 */
export function checkBearer(header: string | null, expected = process.env.MAIA_SERVICE_TOKEN): AuthResult {
  if (!expected) return "unconfigured";
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return "unauthorized";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(match[1].trim()), digest(expected)) ? "ok" : "unauthorized";
}
