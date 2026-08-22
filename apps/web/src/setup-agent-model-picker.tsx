/**
 * First default AGENT, on Setup step 2.
 *
 * Generate is gated on an ACTIVE default AGENT. OpenRouter's catalogue is
 * hundreds of paid ids; official free variants are `:free` suffixes on GET
 * /api/v1/models. A local server lists what it serves. Either way the pick
 * writes a ModelDeployment — same Admit + activate-default path as Models —
 * so the operator never leaves this screen.
 */
import type { AdministratorSession, ModelObservation, ServiceConnectionSummary } from "@orcasynapse/contracts";
import { isOpenRouterEndpoint } from "@orcasynapse/contracts";
import { RefreshCw as SyncIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  OrcaSynapseApiError,
  changeModelDeploymentState,
  createModelDeployment,
  getModelDeployments,
  getModelObservations,
  refreshConnectionModels,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import { Alert, Button, Field, Select, StatusText } from "./ui/index.js";
import { admitLimits, setupAgentDeploymentSlug, setupAgentModelChoices } from "./setup-agent-model.js";

interface SetupAgentModelPickerProps {
  connection: ServiceConnectionSummary;
  session?: AdministratorSession | null;
  onReady: () => void;
  onSessionExpired: () => void;
}

export function SetupAgentModelPicker({
  connection,
  session,
  onReady,
  onSessionExpired,
}: SetupAgentModelPickerProps) {
  const { can } = adminAccess(session ?? null);
  const canManage = session == null ? true : can("models:manage");
  const openRouter = isOpenRouterEndpoint(connection.baseUrl);
  const [items, setItems] = useState<ModelObservation[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<"refresh" | "admit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo(() => setupAgentModelChoices(items, connection.baseUrl), [items, connection.baseUrl]);

  const load = async (refresh: boolean) => {
    setBusy("refresh");
    setError(null);
    try {
      const observed = refresh
        ? await refreshConnectionModels(connection.id)
        : await getModelObservations(connection.id);
      setItems(observed.items);
      setSelected((current) => {
        const next = setupAgentModelChoices(observed.items, connection.baseUrl);
        if (current && next.some((item) => item.alias === current)) return current;
        return next.length === 1 ? next[0]!.alias : "";
      });
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "The model catalogue could not be loaded.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load(true);
    // The connection id is the catalogue. Callback identity must not retrigger
    // a Refresh against OpenRouter on every parent poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  const admit = async () => {
    const observation = choices.find((item) => item.alias === selected);
    if (!observation || !canManage || busy) return;
    setBusy("admit");
    setError(null);
    try {
      const limits = admitLimits(observation);
      const name = (observation.displayName ?? observation.alias).slice(0, 120);
      const { items: routes } = await getModelDeployments();
      let route = routes.find((model) =>
        model.modelAlias === observation.alias
        && model.workload === "AGENT"
        && model.connection.id === connection.id);
      if (!route) {
        route = await createModelDeployment({
          slug: setupAgentDeploymentSlug(observation.alias),
          displayName: name.length >= 2 ? name : observation.alias.slice(0, 120).padEnd(2, "x"),
          modelAlias: observation.alias,
          workload: "AGENT",
          connectionId: connection.id,
          version: "observed",
          license: null,
          contextWindowTokens: limits.contextWindowTokens,
          maxOutputTokens: limits.maxOutputTokens,
          maxConcurrentRequests: 2,
        });
      }
      if (route.status !== "ACTIVE" || !route.isDefault) {
        await changeModelDeploymentState(route.id, "activate", {
          expectedRevision: route.revision,
          reason: "Setup default agent model",
          makeDefault: true,
        });
      }
      onReady();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      else setError(cause instanceof Error ? cause.message : "The default Agent model could not be activated.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-raised/40 p-3" role="region" aria-label="Default agent model">
      <div>
        <StatusText tone="warn">Required for the installer</StatusText>
        <strong className="mt-1 block font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
          Pick the default Agent model
        </strong>
        <p className="mb-0 mt-1 max-w-[62ch] text-caption leading-relaxed text-muted">
          {openRouter
            ? "Official OpenRouter free variants from the live catalogue. Rate limits are low and the set changes; paid models stay on Gateway → Models."
            : "Ids this inference server listed. Hermes is seeded with the one you pick; you can admit more later on Gateway → Models."}
        </p>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {busy === null && choices.length === 0 && !error ? (
        <p className="m-0 text-caption leading-relaxed text-muted">
          {openRouter
            ? "No free variants are in the live catalogue right now. Refresh, or admit a paid model on Gateway → Models."
            : "This inference server listed no chat models. Refresh after it is serving one."}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <Field label={openRouter ? "Free OpenRouter model" : "Served model"} className="min-w-[16rem] flex-1">
          <Select
            aria-label={openRouter ? "Free OpenRouter model" : "Served model"}
            value={selected}
            disabled={busy !== null || choices.length === 0}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">{choices.length === 0 ? "Refresh the catalogue" : "Select a model"}</option>
            {choices.map((item) => (
              <option key={item.id} value={item.alias}>
                {item.displayName ? `${item.displayName} (${item.alias})` : item.alias}
              </option>
            ))}
          </Select>
        </Field>
        <Button disabled={busy !== null} onClick={() => void load(true)}>
          <SyncIcon size={16} />
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </Button>
        {canManage ? (
          <Button variant="primary" disabled={busy !== null || !selected} onClick={() => void admit()}>
            {busy === "admit" ? "Activating…" : "Use as default Agent"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
