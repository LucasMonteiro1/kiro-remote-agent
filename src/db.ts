import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

type Sql = NeonQueryFunction<false, false>;

let sql: Sql | null = null;
let sqlUrl: string | null = null;

/**
 * Lazily creates a singleton Neon serverless driver instance, used only by
 * the hub's best-effort durability flush (see hub.ts). Unlike the relay's
 * copy of this file, this is optional: if DATABASE_URL is unset, the hub
 * never calls this and runs purely in-memory.
 */
export function getSql(databaseUrl: string): Sql {
  if (sql && sqlUrl === databaseUrl) return sql;
  sql = neon(databaseUrl, { fetchOptions: { cache: 'no-store' } });
  sqlUrl = databaseUrl;
  return sql;
}
