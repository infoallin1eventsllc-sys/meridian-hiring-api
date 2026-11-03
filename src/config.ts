// All settings come from environment variables so the same code runs locally,
// in CI and on Vercel. See .env.example for what each one does.

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export interface Config {
  databaseUrl: string;
  publicBaseUrl: string;
  encryptionKey: Buffer;
  cronSecret?: string;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseJwtSecret?: string;
  storageBucket: string;
  /** Lets webhooks reach localhost and plain http. Tests only. */
  allowPrivateWebhooks: boolean;
}

export function loadConfig(): Config {
  // POSTGRES_URL is what Vercel's Supabase integration sets (the pooled connection).
  const databaseUrl = optional('DATABASE_URL') ?? optional('POSTGRES_URL');
  if (!databaseUrl) throw new Error('DATABASE_URL (or POSTGRES_URL) is required');
  const key = optional('APP_ENCRYPTION_KEY');
  if (!key) throw new Error('APP_ENCRYPTION_KEY is required (32 random bytes, base64)');
  const encryptionKey = Buffer.from(key, 'base64');
  if (encryptionKey.length !== 32) throw new Error('APP_ENCRYPTION_KEY must decode to 32 bytes');
  const onVercel = Boolean(process.env.VERCEL);
  // Vercel tells each deployment its production domain, so PUBLIC_BASE_URL is optional there.
  const vercelDomain = optional('VERCEL_PROJECT_PRODUCTION_URL');
  const publicBaseUrl = optional('PUBLIC_BASE_URL') ?? (vercelDomain ? `https://${vercelDomain}` : undefined);
  if (onVercel && !publicBaseUrl) throw new Error('PUBLIC_BASE_URL is required in production');
  if (onVercel && optional('WEBHOOK_ALLOW_PRIVATE') === '1') {
    throw new Error('WEBHOOK_ALLOW_PRIVATE turns off SSRF protection and must not be set in production');
  }
  return {
    databaseUrl,
    publicBaseUrl: (publicBaseUrl ?? 'http://localhost:8787').replace(/\/$/, ''),
    encryptionKey,
    cronSecret: optional('CRON_SECRET'),
    supabaseUrl: optional('SUPABASE_URL')?.replace(/\/$/, ''),
    supabaseServiceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseJwtSecret: optional('SUPABASE_JWT_SECRET'),
    storageBucket: optional('STORAGE_BUCKET') ?? 'resumes',
    allowPrivateWebhooks: optional('WEBHOOK_ALLOW_PRIVATE') === '1',
  };
}
