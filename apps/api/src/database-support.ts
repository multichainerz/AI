import { sql } from "drizzle-orm";

/** PostgreSQL unique-violation SQLSTATE, the driver-level equivalent of Prisma P2002. */
export const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps driver failures, so the SQLSTATE can sit on the thrown error or
 * anywhere on its cause chain depending on where the statement failed. Checking
 * only the outermost error silently misses genuine conflicts.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Transaction-scoped advisory lock. Serialises the read-decide-write sequences
 * that optimistic revision checks alone cannot make safe, and releases with the
 * transaction rather than needing an explicit unlock.
 */
export function advisoryLock(key: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Increments an integer column in place without reading it first. */
export function increment(column: unknown) {
  return sql`${column} + 1`;
}
