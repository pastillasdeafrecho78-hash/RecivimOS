import { createHash } from "node:crypto";
import { z } from "zod";

const SECRET_MIN_LEN = 16;

/** Vercel y otros paneles suelen persistir "" en lugar de omitir la variable. */
const emptyToUndefined = (value: unknown): unknown =>
  value === "" || value === null ? undefined : value;

const optionalUrl = () =>
  z.preprocess(emptyToUndefined, z.string().url().optional());

/** Si el valor es corto (<16), se deriva de forma estable para no romper el arranque (HMAC sigue siendo fuerte). */
const normalizeRequiredSecret = (value: unknown, label: string, fallback: string): string => {
  if (value === "" || value === null || value === undefined) {
    return fallback;
  }
  const s = String(value).trim();
  if (s.length >= SECRET_MIN_LEN) return s;
  return createHash("sha256").update(`${label}|${s}`, "utf8").digest("hex");
};

const normalizeOptionalSecret = (value: unknown, label: string): string | undefined => {
  if (value === "" || value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  if (s.length >= SECRET_MIN_LEN) return s;
  return createHash("sha256").update(`${label}|${s}`, "utf8").digest("hex");
};

const optionalSecretMin = (label: string) =>
  z.preprocess(
    (v) => normalizeOptionalSecret(v, label),
    z.string().min(SECRET_MIN_LEN).optional()
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().default(3000)),
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().min(1).default("postgresql://postgres:postgres@localhost:5432/pedimos")
  ),
  IDEMPOTENCY_TTL_HOURS: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(48)),
  SERVIMOS_PUBLIC_BASE_URL: optionalUrl(),
  PUBLIC_SESSION_SECRET: z.preprocess(
    (v) => normalizeRequiredSecret(v, "PUBLIC_SESSION_SECRET", "pedimos-public-session-dev-secret"),
    z.string().min(SECRET_MIN_LEN)
  ),
  PUBLIC_SESSION_TTL_MINUTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(180)),
  ACCOUNT_SESSION_SECRET: z.preprocess(
    (v) => normalizeRequiredSecret(v, "ACCOUNT_SESSION_SECRET", "pedimos-account-session-dev-secret"),
    z.string().min(SECRET_MIN_LEN)
  ),
  ACCOUNT_SESSION_TTL_MINUTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(10080)),
  BENEFITS_GRANT_SECRET: optionalSecretMin("BENEFITS_GRANT_SECRET"),
  META_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  META_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  META_REDIRECT_URI: optionalUrl()
});

export type AppEnv = z.infer<typeof envSchema>;

export const env: AppEnv = envSchema.parse(process.env);
