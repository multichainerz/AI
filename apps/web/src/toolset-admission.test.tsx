import { decideToolsetAdmissionSchema, toolsetAdmissionListSchema, type ToolsetAdmission } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";

/**
 * The admission panel is driven by two sources merged in a memo — the runtime's
 * catalogue and this installation's decisions — and `renderToStaticMarkup` does
 * not run effects, so asserting against its markup would test nothing. These
 * cover the contract both ends agree on, plus the merge rule itself, which is
 * the part that can be wrong without anything failing loudly.
 */

const admission: ToolsetAdmission = {
  toolsetName: "clarify",
  admitted: true,
  reason: "Asks the operator a question; touches no data.",
  admittedBy: "6d1c9e77-2b3a-4c5d-8e9f-0a1b2c3d4e5f",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

/** Mirrors the view's merge: catalogue rows, plus admissions it never reported. */
function merge(
  catalogue: Array<{ name: string; toolCount: number; enabled: boolean }>,
  admissions: readonly ToolsetAdmission[],
) {
  const admittedNames = new Set(admissions.filter(({ admitted }) => admitted).map(({ toolsetName }) => toolsetName));
  const rows = catalogue.map((toolset) => ({
    name: toolset.name,
    enabled: toolset.enabled,
    admitted: admittedNames.has(toolset.name),
  }));
  const known = new Set(rows.map(({ name }) => name));
  for (const entry of admissions) {
    if (known.has(entry.toolsetName)) continue;
    rows.push({ name: entry.toolsetName, enabled: false, admitted: entry.admitted });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

describe("toolset admission contract", () => {
  it("carries the decision, who made it, and why", () => {
    const [item] = toolsetAdmissionListSchema.parse({ items: [admission] }).items;
    expect(item).toMatchObject({ toolsetName: "clarify", admitted: true, admittedBy: admission.admittedBy });
    expect(item?.reason).toBe("Asks the operator a question; touches no data.");
  });

  it("requires a reason for admitting and for revoking", () => {
    // Admitting code execution on a runtime host without saying why is not a
    // decision anyone can audit later.
    expect(decideToolsetAdmissionSchema.safeParse({ admitted: true, reason: "ok" }).success).toBe(false);
    expect(decideToolsetAdmissionSchema.safeParse({ admitted: false, reason: "  " }).success).toBe(false);
    expect(decideToolsetAdmissionSchema.safeParse({ admitted: true, reason: "Reviewed with the data owner." }).success).toBe(true);
    expect(decideToolsetAdmissionSchema.safeParse({ admitted: false, reason: "Withdrawn pending review." }).success).toBe(true);
  });

  it("rejects a stray field riding along with a decision", () => {
    expect(decideToolsetAdmissionSchema.safeParse({
      admitted: true, reason: "Reviewed with the data owner.", toolsetName: "code_execution",
    }).success).toBe(false);
  });
});

describe("admission merge", () => {
  it("marks a toolset the runtime enabled but nobody admitted", () => {
    // This is the state that refuses every run, so it has to be visible.
    const rows = merge(
      [{ name: "code_execution", toolCount: 1, enabled: true }],
      [],
    );
    expect(rows).toEqual([{ name: "code_execution", enabled: true, admitted: false }]);
  });

  it("keeps an admitted toolset on screen even when the runtime never reported it", () => {
    // Hiding it would make a pending revocation look like it had happened.
    const rows = merge([{ name: "clarify", toolCount: 1, enabled: false }], [
      admission,
      { ...admission, toolsetName: "todo" },
    ]);
    expect(rows.map(({ name }) => name)).toEqual(["clarify", "todo"]);
    expect(rows.find(({ name }) => name === "todo")).toMatchObject({ admitted: true, enabled: false });
  });

  it("treats a revoked admission as not admitted", () => {
    const rows = merge([{ name: "clarify", toolCount: 1, enabled: true }], [{ ...admission, admitted: false }]);
    expect(rows[0]).toMatchObject({ name: "clarify", enabled: true, admitted: false });
  });

  it("does not invent drift for a toolset that is admitted and enabled", () => {
    const rows = merge([{ name: "clarify", toolCount: 1, enabled: true }], [admission]);
    expect(rows.filter((row) => row.enabled && !row.admitted)).toEqual([]);
  });
});
