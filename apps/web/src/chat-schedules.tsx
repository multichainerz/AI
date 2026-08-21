import type { ChatSchedule } from "@orcasynapse/contracts";
import { useEffect, useState } from "react";
import {
  createChatSchedule,
  deleteChatSchedule,
  getChatSchedules,
  updateChatSchedule,
} from "./api.js";
import { Alert, Button, Field, MicroLabel, Select, StatusText, Textarea } from "./ui/index.js";

/**
 * The cadences an operator picks from, rather than a number they type.
 *
 * The API bounds the interval at 300s-604800s and the database repeats the
 * bound, so a free number field would mostly be a way to discover those two
 * limits by being refused. These are the intervals somebody actually asks for.
 */
const CADENCES = [
  { label: "Every 15 minutes", seconds: 900 },
  { label: "Hourly", seconds: 3_600 },
  { label: "Every 6 hours", seconds: 21_600 },
  { label: "Daily", seconds: 86_400 },
  { label: "Weekly", seconds: 604_800 },
] as const;

function cadenceLabel(seconds: number): string {
  return CADENCES.find((cadence) => cadence.seconds === seconds)?.label
    // A schedule written through the API can carry any bounded interval, and
    // rendering it as "Unknown" would make a working schedule look broken.
    ?? `Every ${Math.round(seconds / 60)} minutes`;
}

/**
 * When the next turn is due, or why there will not be one.
 *
 * A disabled schedule must never render a next-run time. It has one stored --
 * the claim moved it forward before the failure was known -- and showing it
 * would promise a turn that is not coming, which is the exact confusion this
 * panel exists to remove.
 */
function nextRunLabel(schedule: ChatSchedule): string {
  if (!schedule.enabled) return "Stopped";
  const due = new Date(schedule.nextRunAt).getTime() - Date.now();
  if (due <= 0) return "Due now";
  const minutes = Math.round(due / 60_000);
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `In ${hours} h` : `In ${Math.round(hours / 24)} d`;
}

function outcomeTone(schedule: ChatSchedule): "good" | "warn" | "bad" | "neutral" {
  if (!schedule.enabled) return "bad";
  if (schedule.lastOutcome === "OK") return "good";
  if (schedule.lastOutcome === "SKIPPED") return "warn";
  return "neutral";
}

export function ChatSchedules({ conversationId }: { conversationId: string }) {
  const [schedules, setSchedules] = useState<ChatSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState<number>(86_400);

  const load = async () => {
    try {
      setSchedules((await getChatSchedules(conversationId)).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The schedules could not be loaded.");
    }
  };

  useEffect(() => {
    void load();
    // The conversation is the panel's whole subject; reloading on a change is
    // the point rather than an omission.
  }, [conversationId]);

  const guard = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The schedule could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length === 0) return;
    void guard(async () => {
      await createChatSchedule(conversationId, { prompt: prompt.trim(), intervalSeconds: seconds });
      setPrompt("");
    });
  };

  return (
    <div className="grid gap-4">
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

      <p className="m-0 text-body text-muted">
        A scheduled turn is posted into this conversation as if you had typed it, and answers in
        the thread. It runs with your access, so it stops if your account is disabled.
      </p>

      <form className="grid gap-3" onSubmit={add}>
        <Field label="Prompt">
          <Textarea
            rows={3}
            value={prompt}
            maxLength={128_000}
            placeholder="Summarise anything that changed overnight."
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="How often">
            <Select value={String(seconds)} onChange={(event) => setSeconds(Number(event.target.value))}>
              {CADENCES.map((cadence) => (
                <option key={cadence.seconds} value={cadence.seconds}>{cadence.label}</option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" type="submit" disabled={busy || prompt.trim().length === 0}>
            {busy ? "Saving…" : "Add schedule"}
          </Button>
        </div>
        {/* The first run is one interval out, and saying so stops an operator
            waiting on a turn that was never going to be immediate. */}
        <small className="text-caption text-faint">
          The first turn runs one interval from now.
        </small>
      </form>

      <div className="grid gap-2">
        <MicroLabel>Schedules · {schedules?.length ?? 0}</MicroLabel>
        {schedules === null && <p className="m-0 text-body text-faint">Loading…</p>}
        {schedules?.length === 0 && (
          <p className="m-0 text-body text-faint">Nothing is scheduled on this conversation.</p>
        )}
        {schedules?.map((schedule) => (
          <div key={schedule.id} className="grid gap-2 rounded border border-border bg-raised p-3">
            <div className="flex items-start justify-between gap-3">
              <p className="m-0 min-w-0 text-body text-text">{schedule.prompt}</p>
              <StatusText dot tone={outcomeTone(schedule)} className="shrink-0 normal-case">
                {nextRunLabel(schedule)}
              </StatusText>
            </div>
            <small className="text-caption text-faint">
              {cadenceLabel(schedule.intervalSeconds)} · created by {schedule.createdBySubject}
            </small>
            {/*
              * Why it stopped, in the words the dispatcher stored.
              *
              * Without this a schedule that disabled itself a week ago looks
              * exactly like one that is not due yet, which is the failure mode
              * this whole surface exists to make visible.
              */}
            {schedule.lastDetail && (
              <StatusText tone={outcomeTone(schedule)} className="normal-case">
                {schedule.lastDetail}
              </StatusText>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void guard(() => updateChatSchedule(schedule.id, {
                  enabled: !schedule.enabled,
                  expectedRevision: schedule.revision,
                }))}
              >
                {schedule.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => void guard(() => deleteChatSchedule(schedule.id))}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
