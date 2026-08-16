/**
 * The one place that answers "may this principal use this agent profile?".
 *
 * One function on purpose. Divisions (increment D) add their clause here and
 * nowhere else, so there is no second copy to forget when the rule grows. The
 * checklist item this satisfies is "the visibility rule exists once, in one
 * function"; keeping it in its own module is what makes that checkable rather
 * than aspirational.
 *
 * Today it answers only the existence half of the question, and that is already
 * worth having. `submitRun` and conversation `create` both used to reach a
 * profile by caller-supplied UUID with no check of any kind: the row was loaded
 * and used. Routing both through this function is the seam, and the seam is the
 * deliverable -- the division clause is a two-line change once it lands here.
 *
 * ## Why absence is 404 and not 403
 *
 * A principal who may not see a profile must not be able to tell it apart from
 * one that does not exist. 403 confirms the UUID names something real, which is
 * exactly the fact a division boundary is meant to withhold. So both cases
 * answer the same way, and callers translate this to their own not-found error.
 *
 * Note what is deliberately *not* here: a suspended or unactivated profile is
 * visible. It exists, the caller may see it, and it simply cannot accept work --
 * that stays a 409 conflict at the call site. Conflating the two would tell a
 * user their own division's profile had vanished.
 */

/**
 * The subset of a principal this rule reads.
 *
 * Structural rather than an import of `AgentPrincipal` or `ChatPrincipal`: both
 * satisfy it, and neither package has to depend on the other. Increment D adds
 * `divisionId` here.
 */
export interface ProfileVisibilityPrincipal {
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW";
  scopes: readonly string[];
  /**
   * The caller's division, or null for a user in none.
   *
   * Optional on the interface rather than required because a principal
   * assembled before divisions existed is a caller in no division, which is the
   * narrowest reading and therefore the safe one: absent means "sees only
   * deployment-wide profiles", never "sees everything".
   */
  divisionId?: string | null;
}

/** The subset of a profile this rule reads. */
export interface ProfileVisibilityCandidate {
  id: string;
  /** Null means deployment-wide: visible from every division. */
  divisionId?: string | null;
}

/**
 * Whether `principal` may see and use `profile`.
 *
 * `profile` accepts null/undefined so a call site can hand over the result of a
 * lookup directly. That is not a convenience: it is what makes "the row was not
 * found" and "the row is not yours" one answer at one place, which is the
 * property the 404 depends on.
 */
export function profileVisibleTo<T extends ProfileVisibilityCandidate>(
  principal: ProfileVisibilityPrincipal,
  profile: T | null | undefined,
): profile is T {
  if (profile === null || profile === undefined) return false;
  /*
   * Administrators are deployment-wide, by design rather than by omission.
   *
   * There is no division-scoped administrator anywhere in this product, which
   * is what makes every administration screen safe by construction. It matters
   * most for Agents -> Memory and Agents -> Skills: those are shared per node
   * and *cannot* be filtered by division even in principle, so an administrator
   * bounded to one division would read what every other division's agent had
   * learned. Deployment-wide removes that possibility instead of guarding it.
   */
  if (principal.identityMode === "ADMINISTRATOR_PREVIEW") return true;
  // Null division on a profile means deployment-wide, which every profile is
  // until a super admin deliberately assigns one.
  if (profile.divisionId === null || profile.divisionId === undefined) return true;
  return profile.divisionId === principal.divisionId;
}
