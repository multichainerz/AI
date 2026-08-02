import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { describe, expect, it, vi } from "vitest";
import { PrismaToolActionProcessor } from "./tool-action-processor.js";

const DISPATCH_ID = "26ee2c9d-bcd4-4db8-9c9e-e39ee94c8221";
const CALL_ID = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
const DOCUMENT_ID = "b41d3534-658b-4cf0-a046-2b20b15f44e5";
const JOB_ID = "c197560c-9bf4-4c97-8e48-aac20990f45a";
const WORKER_ID = "worker-1";

function approvedCall(runStatus = "RUNNING") {
  return {
    id: CALL_ID,
    toolId: "d160a1a0-7218-48a4-8a9f-7e1681280fe4",
    status: "EXECUTING",
    arguments: { documentId: DOCUMENT_ID },
    approval: { status: "APPROVED" },
    tool: {
      id: "d160a1a0-7218-48a4-8a9f-7e1681280fe4",
      status: "ACTIVE",
      risk: "CONSEQUENTIAL",
      handlerKey: "builtin.document_memory_resync",
    },
    grant: {
      toolId: "d160a1a0-7218-48a4-8a9f-7e1681280fe4",
      profileVersionId: "11019af2-34a5-41e5-8e3a-cb027f3bf553",
      enabled: true,
      resourceScope: "OWNER_ONLY",
      allowedGroups: [],
      allowedAdminRoles: ["PLATFORM_ADMIN"],
    },
    run: {
      status: runStatus,
      requestedBy: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
      ownerSubject: "platform-admin",
      profileVersionId: "11019af2-34a5-41e5-8e3a-cb027f3bf553",
      profileVersion: 1,
      toolCapabilityTokenHash: new Uint8Array(32).fill(1),
      toolCapabilityExpiresAt: new Date(Date.now() + 60_000),
      profile: { status: "ACTIVE", activeVersion: 1 },
    },
  };
}

function harness(options: {
  runtimeEnabled?: boolean;
  runStatus?: string;
  publication?: { sourceToolDispatchId: string | null; jobId: string | null; generation: number; status: string };
} = {}) {
  let claimToken = "";
  const dispatchUpdateMany = vi.fn(async () => ({ count: 1 }));
  const callUpdate = vi.fn(async () => ({}));
  const callUpdateMany = vi.fn(async () => ({ count: 1 }));
  const publicationUpsert = vi.fn(async () => ({}));
  const publicationUpdate = vi.fn(async () => ({}));
  const publicationUpdateMany = vi.fn(async () => ({ count: 1 }));
  const dispatch = () => ({
    id: DISPATCH_ID,
    callId: CALL_ID,
    status: "PROCESSING",
    attemptCount: 1,
    claimedBy: WORKER_ID,
    claimToken,
    call: approvedCall(options.runStatus),
  });
  const prismaBase: any = {
    $queryRaw: vi.fn(async () => [{ id: DISPATCH_ID }]),
    toolActionDispatch: {
      update: vi.fn(async ({ data }: any) => {
        claimToken = data.claimToken;
        return { id: DISPATCH_ID, attemptCount: 1 };
      }),
      updateMany: dispatchUpdateMany,
      findUnique: vi.fn(async ({ include }: any) => include ? dispatch() : { callId: CALL_ID }),
    },
    toolRuntimeControl: { findUnique: vi.fn(async () => ({ enabled: options.runtimeEnabled ?? true })) },
    administratorSession: { findFirst: vi.fn(async () => ({ role: "PLATFORM_ADMIN" })) },
    enterpriseUserSession: { findFirst: vi.fn() },
    document: {
      findFirst: vi.fn(async () => ({
        id: DOCUMENT_ID,
        ownerSubject: "platform-admin",
        processingGeneration: 3,
      })),
    },
    documentMemoryPublication: {
      findUnique: vi.fn(async () => options.publication ?? null),
      upsert: publicationUpsert,
      update: publicationUpdate,
      updateMany: publicationUpdateMany,
    },
    governedToolCall: { update: callUpdate, updateMany: callUpdateMany },
    auditEvent: { create: vi.fn(async () => ({})) },
  };
  prismaBase.$transaction = vi.fn(async (value: any) => {
    if (typeof value === "function") return value(prismaBase);
    return Promise.all(value);
  });
  return {
    processor: new PrismaToolActionProcessor(prismaBase as OrcaSynapsePrismaClient),
    dispatchUpdateMany,
    callUpdate,
    callUpdateMany,
    publicationUpsert,
    publicationUpdate,
    publicationUpdateMany,
  };
}

describe("PrismaToolActionProcessor", () => {
  it("submits an approved action and completes its durable dispatch", async () => {
    const test = harness();

    await expect(test.processor.processAvailable(WORKER_ID, 1)).resolves.toBe(1);

    expect(test.publicationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ sourceToolDispatchId: DISPATCH_ID, status: "QUEUED" }),
    }));
    expect(test.publicationUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { jobId: expect.any(String) } }));
    expect(test.dispatchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED", submittedJobId: expect.any(String) }),
    }));
    expect(test.callUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED" }),
    }));
  });

  it("cancels fail-closed when policy is revoked after approval", async () => {
    const test = harness({ runtimeEnabled: false });

    await expect(test.processor.processAvailable(WORKER_ID, 1)).resolves.toBe(1);

    expect(test.dispatchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CANCELLED" }),
    }));
    expect(test.callUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "DENIED",
        errorCode: "AUTHORIZATION_REVOKED_AFTER_APPROVAL",
      }),
    }));
  });

  it("cancels fail-closed when the originating run has ended", async () => {
    const test = harness({ runStatus: "DENIED" });

    await expect(test.processor.processAvailable(WORKER_ID, 1)).resolves.toBe(1);

    expect(test.callUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "DENIED", errorCode: "AUTHORIZATION_REVOKED_AFTER_APPROVAL" }),
    }));
  });

  it("adopts an in-flight memory job without resetting its processing state", async () => {
    const test = harness({
      publication: {
        sourceToolDispatchId: null,
        jobId: JOB_ID,
        generation: 3,
        status: "PROCESSING",
      },
    });

    await expect(test.processor.processAvailable(WORKER_ID, 1)).resolves.toBe(1);

    expect(test.publicationUpdate).toHaveBeenCalledWith({
      where: { documentId: DOCUMENT_ID },
      data: { sourceToolDispatchId: DISPATCH_ID },
    });
    expect(test.publicationUpsert).not.toHaveBeenCalled();
    expect(test.dispatchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED", submittedJobId: JOB_ID }),
    }));
  });
});
