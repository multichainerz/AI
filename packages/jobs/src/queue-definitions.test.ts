import { JOB_QUEUE_NAMES } from "@aihub/contracts";
import { describe, expect, it } from "vitest";
import { AIHUB_QUEUE_DEFINITIONS } from "./queue-definitions.js";

describe("AIHub queue definitions", () => {
  it("defines every contracted queue once and creates the dead-letter queue first", () => {
    expect(AIHUB_QUEUE_DEFINITIONS.map(({ name }) => name)).toEqual([
      "aihub.dead-letter",
      ...JOB_QUEUE_NAMES.filter((name) => name !== "aihub.dead-letter"),
    ]);
    expect(new Set(AIHUB_QUEUE_DEFINITIONS.map(({ name }) => name)).size).toBe(
      JOB_QUEUE_NAMES.length,
    );
  });

  it("configures processing queues with retries, backoff, heartbeat, and dead letters", () => {
    const processingQueues = AIHUB_QUEUE_DEFINITIONS.filter(
      ({ name }) => name !== "aihub.dead-letter",
    );

    for (const queue of processingQueues) {
      expect(queue.options.retryLimit).toBeGreaterThan(0);
      expect(queue.options.retryBackoff).toBe(true);
      expect(queue.options.heartbeatSeconds).toBeGreaterThanOrEqual(10);
      expect(queue.options.deadLetter).toBe("aihub.dead-letter");
      expect(queue.options.notify).toBe(true);
    }
  });

  it("does not enable unfinished document and memory workers", () => {
    expect(
      AIHUB_QUEUE_DEFINITIONS.filter(({ workerEnabled }) => workerEnabled).map(({ name }) => name),
    ).toEqual(["aihub.system.probe"]);
  });
});
