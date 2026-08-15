import { decideToolApprovalSchema, toolApprovalListSchema, type ToolApproval } from "./tooling.js";
import { describe, expect, it } from "vitest";

/**
 * The approval wire format, tested where it lives.
 *
 * This began in `apps/web` as a test of the approvals panel. Two things then
 * happened to it. It stopped asserting against markup, because
 * `renderToStaticMarkup` runs no effects and the panel it was "checking" had
 * never rendered — it passed on an unrelated word appearing elsewhere. Then the
 * panel itself was deleted in v5.1.0.
 *
 * What survived both is the part that was always doing the work: the contract
 * the API still enforces on `POST /approvals/:approvalId/decision`, which is
 * live whether or not a screen drives it. An audit read the file's location and
 * called it orphaned; it was misfiled, which is a different thing, so it moved
 * here rather than being deleted.
 */

const approval: ToolApproval = {
  id: "6d1c9e77-2b3a-4c5d-8e9f-0a1b2c3d4e5f",
  callId: "7e2d0f88-3c4b-4d5e-9f0a-1b2c3d4e5f60",
  runId: "8f3e1a99-4d5c-4e6f-a01b-2c3d4e5f6071",
  profileSlug: "hermes-analyst",
  toolSlug: "system-restart",
  toolName: "Restart system",
  requestedBySubject: "user:pilot",
  arguments: { service: "inference" },
  status: "PENDING",
  expiresAt: "2026-08-05T00:15:00.000Z",
  decisionReason: null,
  decisionBy: null,
  decidedAt: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

describe("tool approval contract", () => {
  it("carries everything an operator needs to decide", () => {
    const parsed = toolApprovalListSchema.parse({ items: [approval] });
    const [item] = parsed.items;
    // Deciding blind is the failure mode: who asked, through which agent, for
    // which tool, with what arguments, and how long the decision stays open.
    expect(item).toMatchObject({
      toolName: "Restart system",
      profileSlug: "hermes-analyst",
      requestedBySubject: "user:pilot",
      status: "PENDING",
    });
    expect(item?.arguments).toEqual({ service: "inference" });
    expect(item?.expiresAt).toBe("2026-08-05T00:15:00.000Z");
  });

  it("requires a reason for both approval and rejection", () => {
    // An approval nobody has to justify is not a control, and a rejection
    // without one leaves the next operator guessing.
    expect(decideToolApprovalSchema.safeParse({ decision: "APPROVE", reason: "ok" }).success).toBe(false);
    expect(decideToolApprovalSchema.safeParse({ decision: "REJECT", reason: "  " }).success).toBe(false);
    expect(decideToolApprovalSchema.safeParse({ decision: "APPROVE", reason: "Reviewed with the data owner." }).success).toBe(true);
    expect(decideToolApprovalSchema.safeParse({ decision: "REJECT", reason: "Not authorized for this data." }).success).toBe(true);
  });

  it("accepts only an explicit approve or reject", () => {
    expect(decideToolApprovalSchema.safeParse({ decision: "MAYBE", reason: "unsure about this" }).success).toBe(false);
    // A stray field must not ride along with a decision.
    expect(decideToolApprovalSchema.safeParse({
      decision: "APPROVE", reason: "Reviewed with the data owner.", callId: "x",
    }).success).toBe(false);
  });
});
