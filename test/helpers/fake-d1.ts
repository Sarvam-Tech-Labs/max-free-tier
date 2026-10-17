import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Minimal D1Database fake over node:sqlite (Node ≥ 22.5): prepare/bind/first/all/run/batch/exec.
 * Loads every file in migrations/ so tests run the production schema.
 */
export function createFakeD1(
  migrationsDir = join(__dirname, "..", "..", "migrations"),
): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }

  function statement(sql: string, params: unknown[] = []): D1PreparedStatement {
    const norm = params.map((p) => (p === undefined ? null : p)) as Array<null | number | string>;
    const stmt = {
      bind: (...args: unknown[]) => statement(sql, args),
      first: async <T>(col?: string) => {
        const row = db.prepare(sql).get(...norm) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (col ? row[col] : row) as T;
      },
      all: async <T>() => ({
        results: db.prepare(sql).all(...norm) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        const r = db.prepare(sql).run(...norm);
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: D1PreparedStatement[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    _raw: db,
  } as unknown as D1Database;
}

export function rawDb(d1: D1Database): DatabaseSync {
  return (d1 as unknown as { _raw: DatabaseSync })._raw;
}
