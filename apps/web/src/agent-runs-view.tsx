import type {
  AdminScope, AdministratorSession, AgentProfile, AgentRun, AgentRunEvent,
} from "@orcasynapse/contracts";
import { History, RefreshCw as SyncIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { adminAccess } from "./admin-access.js";
import { RunDetail, RunLedger } from "./agent-run-ledger.js";
import { runningStatuses } from "./agent-status.js";
import {
  OrcaSynapseApiError,
  cancelAgentRun,
  getAgentProfiles,
  getAgentRunEvents,
  getAgentRuns,
} from "./api.js";
import {
  Alert, Button, LockedScreen, Select, WorkspaceIntro, cn,
} from "./ui/index.js";

interface AgentRunsViewProps {
  unlocked: boolean;
  /**
   * The administrator session, when there is one.
   *
   * Optional so tests can omit it and cover the boolean fallback
   * `granted` shares with Profiles: when the prop is absent, `administrator`
   * is the scope check. `app.tsx` always passes the session.
   */
  session?: AdministratorSession | null;
  administrator: boolean;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

/**
 * The execution ledger and run inspection, under Operations.
 *
 * These two panels used to sit on Agents → Profiles beside the kill switch.
 * That mixed control (may Hermes run at all) with reporting (what it ran).
 * Profiles kept the switch; this screen is the reporting half, next to Health
 * and the audit trail.
 */
export function AgentRunsView({
  unlocked, session, administrator, onConfigure, onSessionExpired,
}: AgentRunsViewProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runEvents, setRunEvents] = useState<AgentRunEvent[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { can } = adminAccess(session ?? null);
  const granted = (scope: AdminScope) => (session === undefined ? administrator : can(scope));
  const canControl = granted("agents:control");
  const canCancelRuns = administrator ? canControl : true;

  const latestOnSessionExpired = useRef(onSessionExpired);
  useEffect(() => { latestOnSessionExpired.current = onSessionExpired; }, [onSessionExpired]);

  const runsRef = useRef<AgentRun[]>([]);

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the agent operation.");
  };

  const loadRuns = async () => {
    const runList = await getAgentRuns(administrator);
    runsRef.current = runList.items;
    setRuns(runList.items);
  };

  const load = async () => {
    const [, profileList] = await Promise.all([
      loadRuns(),
      /*
       * Best-effort: the filter is a convenience over a list the ledger already
       * names on each row. A failure here must not take the ledger down with it.
       */
      getAgentProfiles(administrator).catch(() => null),
    ]);
    if (profileList) setProfiles(profileList.items);
  };

  useEffect(() => {
    if (!unlocked) {
      setProfiles([]); setRuns([]); runsRef.current = [];
      return;
    }
    let active = true;
    void load().catch((cause) => active && fail(cause));
    const timer = window.setInterval(() => {
      if (active && runsRef.current.some(({ status }) => runningStatuses.has(status))) void loadRuns().catch(() => undefined);
    }, 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked, administrator]);

  const selectedProfile = useMemo(
    () => profiles.find(({ id }) => id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  const ledgerScoped = selectedProfileId !== "";
  const scopedRuns = useMemo(
    () => (ledgerScoped ? runs.filter(({ profileId }) => profileId === selectedProfileId) : runs),
    [runs, ledgerScoped, selectedProfileId],
  );

  const selectedRun = useMemo(
    () => scopedRuns.find(({ id }) => id === selectedRunId) ?? scopedRuns[0] ?? null,
    [scopedRuns, selectedRunId],
  );

  useEffect(() => {
    if (!unlocked || !selectedRun) {
      setRunEvents([]);
      return;
    }
    let active = true;
    void getAgentRunEvents(selectedRun.id, administrator)
      .then((result) => { if (active) setRunEvents(result.items); })
      .catch((cause) => { if (active) fail(cause); });
    return () => { active = false; };
  }, [unlocked, administrator, selectedRun?.id, selectedRun?.updatedAt]);

  const action = async (key: string, operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key); setError(null);
    try { await operation(); await load(); }
    catch (cause) { fail(cause); }
    finally { setBusy(null); }
  };

  if (!unlocked) {
    return (
      <LockedScreen
        kicker="Operations"
        title="Agent runs"
        mark="AR"
        headline="Authenticated workspace required"
        reason="Sign in to inspect what agents have run, their lifecycle, and what they produced."
        actionLabel="Administrator setup"
        onAction={onConfigure}
      />
    );
  }

  return (
    <div className="workspace-stack agent-runs-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
      <WorkspaceIntro
        icon={<History className="size-4" aria-hidden="true" />}
        title="Agent runs"
        actions={<>
          {profiles.length > 0 && (
            <div className="flex min-w-0 items-center gap-2 text-caption text-muted">
              <span className="shrink-0">Profile</span>
              <Select
                aria-label="Filter by profile"
                className="h-8 w-[190px] text-caption"
                value={selectedProfileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
              >
                <option value="">All profiles</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.version.displayName}</option>
                ))}
              </Select>
            </div>
          )}
          <Button onClick={() => void load().catch(fail)}><SyncIcon size={16} />Refresh</Button>
        </>}
      />

      {error && <Alert className="shrink-0" onDismiss={() => setError(null)}>{error}</Alert>}

      <div className={cn(
        "grid min-h-0 flex-1 gap-3",
        runs.length > 0 && "lg:grid-cols-2",
      )}>
        <RunLedger
          runs={scopedRuns}
          total={runs.length}
          profileName={selectedProfile?.version.displayName ?? null}
          scoped={ledgerScoped}
          administrator={administrator}
          selectedRunId={selectedRun?.id ?? null}
          onSelectRun={setSelectedRunId}
          onScopeChange={(scoped) => { if (!scoped) setSelectedProfileId(""); }}
        />
        {runs.length > 0 && (
          <RunDetail
            run={selectedRun}
            events={runEvents}
            busy={busy}
            canCancel={canCancelRuns}
            onCancel={(run) => void action(`cancel-${run.id}`, () => cancelAgentRun(run.id, administrator))}
          />
        )}
      </div>
    </div>
  );
}
