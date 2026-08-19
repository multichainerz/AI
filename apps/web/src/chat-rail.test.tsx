/**
 * @vitest-environment jsdom
 *
 * The conversation rail with more than one conversation in it, which nothing
 * covered: `chat-view.test.tsx` renders a single-item list, so every rule the
 * rail actually has -- date grouping, the title/time line, the archived label
 * standing in for a timestamp -- was asserted by nothing.
 *
 * It doubles as the way to *look* at a populated rail without a signed-in
 * session, which is what a density change needs and a diff cannot give. Set
 * `RAIL_PREVIEW_OUT` to a path and this writes the rendered markup there; pair
 * it with the stylesheet from `pnpm --filter @orcasynapse/web build` and serve
 * it from `apps/web/public`. The fixture is deliberately shaped like a real
 * operator's rail -- long titles in a non-English language, one thread whose
 * last turn failed -- because a rail of short English titles never truncates
 * and so never shows the problem being fixed.
 */
import type { AgentProfile, ChatConversation } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Local-time constructors throughout. `formatConversationTime` compares
// `toDateString()` values, so a UTC fixture puts rows in whichever date group
// the runner's offset happens to produce -- green here, "Yesterday" in CI.
const NOW = new Date(2026, 7, 15, 20, 30);

const at = (hour: number, minute: number) => new Date(2026, 7, 15, hour, minute).toISOString();

const row = (
  index: number,
  title: string,
  lastMessagePreview: string | null,
  over: Record<string, unknown> = {},
) => ({
  id: `8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d${String(index).padStart(2, "0")}`,
  title,
  modelAlias: "hermes-agent",
  profileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  profileName: "Administrator",
  status: "ACTIVE",
  messageCount: 4,
  lastMessagePreview,
  createdAt: at(19, 0),
  updatedAt: at(20 - index, 9),
  lastMessageAt: at(20 - index, 9),
  ...over,
}) as unknown as ChatConversation;

const conversations = [
  row(0, "saya mau buat game simulasi nuklir", "Baik, saya sudah mencatat bahwa kamu tinggal di Jakarta."),
  row(1, "buatin lagu indonesia raya karaoke", "Saya tidak dapat menerjemahkan atau mengarang ulang lirik lagu kebangsaan."),
  row(2, "buat md3 untuk kata kata \"halo dunia\"", "Berikut adalah beberapa teks Lorem Ipsum yang bisa kamu pakai."),
  row(3, "buatin tulisan ASCII ORCA", "Berikut adalah versi ikan orca yang sedang \"joget\" dalam ASCII."),
  // A failed turn, whose preview is the runtime's error rather than an answer.
  // The rail must not put this in front of a reader looking for a thread.
  row(4, "install MCP ini https://github.com/example/server",
    "API call failed after 3 retries: HTTP 530 — Cloudflare Tunnel error | idle-backup-vessel-racing.trycloudflare.com — Ray a2c892df886e3673-FRA"),
  row(5, "kamu bisa koneksi dengan Facebook?", "Saya tidak bisa terhubung langsung ke Facebook."),
  row(6, "Buatin postingan facebook untuk promo", "**Judul: Selamat Datang di Indonesia: Negara Kepulauan Terbesar**"),
  row(7, "buatkan press release kerjasama", "Berikut adalah versi press release dengan nada yang lebih formal."),
  // No timestamp is rendered for an archived conversation -- the status word
  // takes that slot instead, which is the one case where the title's share of
  // the line changes.
  row(8, "Propose a session hygiene policy", "The `skill_view` tool is not available in this environment.", {
    status: "ARCHIVED",
  }),
  // Yesterday, so the rail has a second date group and the sticky heading
  // between them is exercised rather than assumed.
  row(9, "rangkuman insiden minggu lalu", null, {
    updatedAt: new Date(2026, 7, 14, 14, 2).toISOString(),
    lastMessageAt: new Date(2026, 7, 14, 14, 2).toISOString(),
  }),
];

const profile = {
  id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  name: "Administrator",
  status: "ACTIVE",
  version: { displayName: "Administrator v1" },
  activeVersionConfiguration: { displayName: "Administrator v1" },
} as unknown as AgentProfile;

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: conversations })),
    getChatConversation: vi.fn(async () => ({ ...conversations[0], messages: [] })),
    getAgentProfiles: vi.fn(async () => ({ items: [profile] })),
  };
});

Element.prototype.scrollIntoView = () => undefined;

const { ChatView } = await import("./chat-view.js");

const props = {
  unlocked: true,
  displayName: "Operator",
  administratorReadiness: null,
  onSignIn: vi.fn(),
  onConfigure: vi.fn(),
  onOpenAgents: vi.fn(),
  onOpenPlatform: vi.fn(),
  onSessionExpired: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function renderRail() {
  render(<ChatView {...props} />);
  const rail = await screen.findByLabelText("Conversation history");
  await waitFor(() => expect(within(rail).getAllByRole("button").length).toBeGreaterThan(1));
  return rail;
}

describe("conversation rail", () => {
  it("renders every conversation, grouped by date", async () => {
    const rail = await renderRail();

    expect(within(rail).getAllByRole("button")).toHaveLength(conversations.length);
    // Both groups, in order: nine conversations today and one yesterday.
    expect(within(rail).getAllByRole("heading", { level: 3 }).map((node) => node.textContent))
      .toEqual(["Today", "Yesterday"]);

    if (process.env.RAIL_PREVIEW_OUT) {
      writeFileSync(process.env.RAIL_PREVIEW_OUT, document.body.innerHTML, "utf8");
    }
  });

  it("gives each row a title and a time that are separately readable", async () => {
    const rail = await renderRail();
    const first = within(rail).getAllByRole("button")[0]!;

    // Two distinct strings, not one run-on label: whatever the CSS does to
    // them, a row must never merge its timestamp into its title.
    expect(within(first).getByText("saya mau buat game simulasi nuklir")).toBeTruthy();
    // Loose on format because the time is locale-rendered ("20:09" or
    // "08:09 PM" depending on the runner) and strict on there being one.
    expect(within(first).getByText(/\d{1,2}:\d{2}/)).toBeTruthy();
  });

  it("clamps each date group's column so a long title cannot widen the rail", async () => {
    /*
     * A class assertion because jsdom has no layout engine and so cannot see
     * the failure this pins: with a bare `grid`, the implicit column is `auto`,
     * which sizes to max-content -- and the Button base sets `whitespace-nowrap`,
     * so max-content is the longest title in the group with no wrapping. The
     * column outgrew the rail, every timestamp rode off the right edge, and the
     * titles clipped without an ellipsis. Rendered, it read as a rail that had
     * simply lost its timestamps.
     */
    const rail = await renderRail();
    const groups = [...rail.querySelectorAll("section")];

    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.className).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("labels an archived conversation instead of timing it", async () => {
    const rail = await renderRail();
    const archived = within(rail).getByRole("button", { name: /session hygiene policy/ });

    expect(within(archived).getByText("Archived")).toBeTruthy();
    expect(within(archived).queryByText(/\d{1,2}:\d{2}/)).toBeNull();
  });

  it("keeps the last message out of the rail entirely", async () => {
    // The rail names threads; it does not quote them. A preview is the
    // assistant's reply, and when the turn failed it is the runtime's error --
    // so the row that used to read like a tunnel outage now reads like the
    // thing the operator actually asked for.
    const rail = await renderRail();
    const failed = within(rail).getByRole("button", { name: /install MCP ini/ });

    expect(failed.textContent).not.toMatch(/Cloudflare|HTTP 530|Ray /);
    expect(within(rail).queryByText(/Baik, saya sudah mencatat/)).toBeNull();
    // Still searchable, just not on display.
    expect(conversations[4]!.lastMessagePreview).toMatch(/Cloudflare/);
  });
});
