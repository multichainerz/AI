import type { GuardrailRule } from "@orcasynapse/contracts";
import { eq, sql } from "drizzle-orm";
import type { OrcaSynapseDatabase } from "./drizzle/client.js";
import { guardrailPolicy } from "./drizzle/schema.js";

export const DEFAULT_RUNTIME_TEXT_POLICY = {
  maxInputCharacters: 128_000,
  maxOutputCharacters: 256_000,
  blockControlCharacters: true,
  blockCredentialPatterns: true,
  rules: [] as GuardrailRule[],
};

export type RuntimeTextPolicyResolution =
  | { status: "default" }
  | { status: "active"; policy: {
      id: string;
      version: string;
      maxInputCharacters: number;
      maxOutputCharacters: number;
      blockControlCharacters: boolean;
      blockCredentialPatterns: boolean;
      rules: GuardrailRule[];
    } }
  | { status: "unresolved"; activeCount: number };

export async function resolveRuntimeTextPolicy(db: OrcaSynapseDatabase): Promise<RuntimeTextPolicyResolution> {
  const [enforced] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(guardrailPolicy);
  if ((enforced?.total ?? 0) === 0) return { status: "default" };

  const active = await db
    .select({
      id: guardrailPolicy.id,
      version: guardrailPolicy.version,
      maxInputCharacters: guardrailPolicy.maxInputCharacters,
      maxOutputCharacters: guardrailPolicy.maxOutputCharacters,
      blockControlCharacters: guardrailPolicy.blockControlCharacters,
      blockCredentialPatterns: guardrailPolicy.blockCredentialPatterns,
      rules: guardrailPolicy.rules,
    })
    .from(guardrailPolicy)
    .where(eq(guardrailPolicy.status, "ACTIVE"))
    .limit(2);
  if (active.length !== 1) return { status: "unresolved", activeCount: active.length };
  const policy = active[0]!;
  return {
    status: "active",
    policy: { ...policy, rules: (policy.rules ?? []) as GuardrailRule[] },
  };
}
