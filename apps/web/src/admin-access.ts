import type { AdminScope, AdministratorSession } from "@orcasynapse/contracts";

/**
 * What an administrator session may actually do right now.
 *
 * One definition, because every admin view needs the same answer and getting it
 * subtly wrong is invisible until it ships: `requireAdmin` on the API refuses a
 * session that is pending a forced password change, so a view that treats
 * "signed in" as "usable" renders a full workspace whose every request returns
 * 403. Deriving the state here keeps the locked screen and the API in agreement.
 */
export interface AdminAccess {
  /** True only when the session may call admin routes. */
  unlocked: boolean;
  scopes: readonly AdminScope[];
  /** Whether the session grants a scope. False whenever the session is locked. */
  can: (scope: AdminScope) => boolean;
}

export function adminAccess(session: AdministratorSession | null): AdminAccess {
  const unlocked = session !== null && session.passwordChangeRequired !== true;
  const scopes = unlocked ? session.scopes : [];
  return { unlocked, scopes, can: (scope) => scopes.includes(scope) };
}
