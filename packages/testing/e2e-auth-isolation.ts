import type { Pool } from 'pg';

// This is test infrastructure, never mounted in an HTTP app. The Playwright
// runner creates a fresh schema name, and the server must CREATE (not reuse) it.
export function e2eSchema(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (env.NODE_ENV === 'production' || (env.FREEDOM_ENV && env.FREEDOM_ENV !== 'local')) {
    throw Error('Browser test auth isolation is local-only.');
  }
  if (!value || !/^fp_e2e_[a-f0-9]{32}$/.test(value)) {
    throw Error('A run-specific Playwright schema is required.');
  }
  return value;
}

/** Reset between cases only; production limits still apply within each case. */
export async function resetE2eAuthState(pool: Pool, schema: string): Promise<void> {
  e2eSchema(schema);
  const connection = await pool.connect();
  try {
    const current = (await connection.query('SELECT current_schema() AS schema')).rows[0]?.schema;
    if (current !== schema) throw Error('Refusing to reset auth outside the Playwright schema.');
    // Explicit qualification prevents search_path fallback to the local demo.
    // These two tables contain counters only; user/session/application data stays intact.
    await connection.query(`TRUNCATE "${schema}".auth_rate_limits, "${schema}".login_attempts`);
  } finally {
    connection.release();
  }
}
