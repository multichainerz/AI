/**
 * Buckets the conversation rail by when each thread was last spoken in.
 *
 * A flat list of forty titles gives a reader nothing to navigate by; the date is
 * the only axis anyone actually remembers a conversation along. Kept as a pure
 * function of `(items, now)` rather than a hook so the boundaries can be tested
 * without rendering and without a fake clock.
 */

export interface ConversationGroup<T> {
  /** Stable across renders and independent of the label's wording. */
  key: string;
  label: string;
  items: T[];
}

/** The minimum a row has to carry to be placed. */
export interface DatedConversation {
  /**
   * Null for a conversation created but never sent to, which the rail still
   * lists. It gets a bucket of its own rather than being dated by `createdAt`:
   * a thread with no messages has no "last message", and pretending otherwise
   * files an empty draft among real history.
   */
  lastMessageAt: string | null;
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

/** Midnight local time, which is the boundary a reader means by "yesterday". */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Ordered groups, newest first, with empty buckets dropped.
 *
 * Order inside a bucket is the order given, so whatever the server sorted by is
 * preserved.
 */
export function groupConversationsByDate<T extends DatedConversation>(
  items: readonly T[],
  now: Date,
): ConversationGroup<T>[] {
  const today = startOfDay(now);
  const day = 24 * 60 * 60 * 1_000;
  const fixed = new Map<string, ConversationGroup<T>>();
  const months = new Map<string, ConversationGroup<T>>();
  const unsent: T[] = [];

  const into = (key: string, label: string, item: T, bucket: Map<string, ConversationGroup<T>>): void => {
    const existing = bucket.get(key);
    if (existing) existing.items.push(item);
    else bucket.set(key, { key, label, items: [item] });
  };

  for (const item of items) {
    if (!item.lastMessageAt) {
      unsent.push(item);
      continue;
    }
    const at = new Date(item.lastMessageAt);
    // An unparseable timestamp is data this cannot place; filing it under a
    // confident date would be worse than admitting it has none.
    if (Number.isNaN(at.getTime())) {
      unsent.push(item);
      continue;
    }
    const elapsed = today - startOfDay(at);
    if (elapsed <= 0) into("today", "Today", item, fixed);
    else if (elapsed <= day) into("yesterday", "Yesterday", item, fixed);
    else if (elapsed < 7 * day) into("week", "Previous 7 days", item, fixed);
    else if (elapsed < 30 * day) into("month", "Previous 30 days", item, fixed);
    else into(`m-${at.getFullYear()}-${at.getMonth()}`, MONTH_FORMAT.format(at), item, months);
  }

  const ordered: ConversationGroup<T>[] = [];
  for (const key of ["today", "yesterday", "week", "month"]) {
    const group = fixed.get(key);
    if (group) ordered.push(group);
  }
  // Month keys sort lexically in the wrong order once a month index passes 9,
  // so they are ordered by the newest item each actually holds.
  ordered.push(...[...months.values()].sort((left, right) =>
    new Date(right.items[0]!.lastMessageAt!).getTime() - new Date(left.items[0]!.lastMessageAt!).getTime()));
  if (unsent.length > 0) ordered.push({ key: "unsent", label: "No messages", items: unsent });
  return ordered;
}
