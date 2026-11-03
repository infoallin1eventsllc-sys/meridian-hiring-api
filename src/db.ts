import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export function createSql(url: string): Sql {
  return postgres(url, {
    // Supabase's pooler runs in transaction mode, which does not support
    // prepared statements.
    prepare: false,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    types: {
      // Return bigint ids as JS numbers; ours never get near 2^53.
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
}

export interface TenantContext {
  companyId: string;
  /** Who is acting, e.g. "api_key:<uuid>" or "user:<uuid>". Stamped on history rows. */
  actor: string;
}

/**
 * Runs `fn` in a transaction that can only see one company's rows.
 * SET LOCAL ROLE drops to hire_app, which is bound by row-level security.
 */
export async function withTenant<T>(sql: Sql, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role hire_app`;
    await tx`select set_config('app.company_id', ${ctx.companyId}, true),
                    set_config('app.actor', ${ctx.actor}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
