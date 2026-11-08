/**
 * Reads a required environment variable at call time (never at import time),
 * so a missing secret fails loudly on use instead of silently at startup.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set - add it to your .env (see .env.example)`);
  return value;
}

/** Authorization header for the IZI by EDF APIs. */
export const iziAuthHeader = (): string => `Bearer ${requireEnv("IZI_AUTH_TOKEN")}`;
