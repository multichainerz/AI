import { describe, expect, it } from "vitest";
import { groupConversationsByDate } from "./conversation-groups.js";

const NOW = new Date("2026-08-09T14:30:00");
const at = (value: string | null) => ({ lastMessageAt: value, id: value ?? "none" });

describe("groupConversationsByDate", () => {
  it("buckets by the day boundary a reader means, not by elapsed hours", () => {
    /*
     * 00:05 today is "Today" even though it is fourteen hours ago, and 23:55
     * yesterday is "Yesterday" even though it is fifteen minutes older. An
     * elapsed-time rule gets both wrong.
     */
    const groups = groupConversationsByDate([
      at("2026-08-09T00:05:00"),
      at("2026-08-08T23:55:00"),
    ], NOW);
    expect(groups.map(({ key }) => key)).toEqual(["today", "yesterday"]);
  });

  it("orders the buckets newest first and drops the empty ones", () => {
    const groups = groupConversationsByDate([
      at("2026-03-02T09:00:00"),
      at("2026-08-09T09:00:00"),
      at("2026-07-20T09:00:00"),
      at("2026-08-05T09:00:00"),
    ], NOW);
    expect(groups.map(({ key, label }) => `${key}:${label}`)).toEqual([
      "today:Today",
      "week:Previous 7 days",
      "month:Previous 30 days",
      "m-2026-2:March 2026",
    ]);
  });

  it("orders month buckets by date rather than by key", () => {
    // "m-2026-10" sorts before "m-2026-9" lexically, which would file November
    // above December and October above November for the rest of the year.
    const groups = groupConversationsByDate([
      at("2025-10-04T09:00:00"),
      at("2025-12-04T09:00:00"),
      at("2025-11-04T09:00:00"),
    ], NOW);
    expect(groups.map(({ label }) => label)).toEqual(["December 2025", "November 2025", "October 2025"]);
  });

  it("gives a conversation that was never sent to its own bucket, last", () => {
    // A thread with no messages has no "last message". Dating it by createdAt
    // would file an empty draft among real history.
    const groups = groupConversationsByDate([at(null), at("2026-08-09T09:00:00")], NOW);
    expect(groups.map(({ key }) => key)).toEqual(["today", "unsent"]);
    expect(groups.at(-1)?.label).toBe("No messages");
  });

  it("files an unparseable timestamp as undated rather than guessing", () => {
    expect(groupConversationsByDate([at("not a date")], NOW)[0])
      .toMatchObject({ key: "unsent", label: "No messages" });
  });

  it("preserves the order it was given inside a bucket", () => {
    // Whatever the server sorted by survives; this only groups.
    const groups = groupConversationsByDate([
      at("2026-08-09T09:00:00"),
      at("2026-08-09T11:00:00"),
      at("2026-08-09T10:00:00"),
    ], NOW);
    expect(groups[0]?.items.map(({ id }) => id)).toEqual([
      "2026-08-09T09:00:00", "2026-08-09T11:00:00", "2026-08-09T10:00:00",
    ]);
  });

  it("returns nothing for nothing", () => {
    expect(groupConversationsByDate([], NOW)).toEqual([]);
  });
});
