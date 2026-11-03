import type { Config } from './config.js';
import type { Deps } from './context.js';
import { createSql } from './db.js';
import { MemoryStorage, SupabaseStorage, type Storage } from './storage.js';

export function buildDeps(config: Config, background: Deps['background']): Deps {
  let storage: Storage;
  if (config.supabaseUrl && config.supabaseServiceRoleKey) {
    storage = new SupabaseStorage(config.supabaseUrl, config.supabaseServiceRoleKey, config.storageBucket);
  } else {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: résumés are kept in memory only.');
    storage = new MemoryStorage(config.publicBaseUrl);
  }
  return { sql: createSql(config.databaseUrl), config, storage, background };
}
