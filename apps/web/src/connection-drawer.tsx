import {
  isOpenRouterEndpoint,
  OPENROUTER_INFERENCE,
  type CreateServiceConnection,
  type ConnectionMonitoringControl,
  type ConnectionTestResult,
  type ConfigurationRevisionList,
  type Environment,
  type InferenceCatalogueRequest,
  type InferenceCatalogueResult,
  type InferenceDiscoveryRequest,
  type InferenceDiscoveryResult,
  type ServiceConnectionConfiguration,
  type ServiceConnectionSummary,
  type ServiceKind,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, Cpu, Globe, Server, Shield } from "lucide-react";
import { slugAsTyped, slugify } from "./slug.js";
import { connectionDefinitions, inferenceEndpointPresets } from "./connection-definitions.js";
import { Alert, Button, Dialog, Field, Input, Mark, MicroLabel, Select, StatusText, toneFor } from "./ui/index.js";
import { Switch } from "@/components/ui/switch";
import { cn } from "./ui/cn.js";

export interface ConnectionDraft extends CreateServiceConnection {
  existingId?: string;
}

/*
 * Sign-in, recovery and the forced password change used to be branches of this
 * drawer, because it was the only surface a signed-out operator could reach.
 * The front page owns the signed-out world now and `AdminSignInDialog` owns
 * elevation from inside the shell, so this dialog is purely what its name
 * says: connection configuration, opened only for an unlocked administrator.
 */
interface ConnectionDrawerProps {
  busy: boolean;
  connections: ServiceConnectionSummary[];
  monitoring: ConnectionMonitoringControl | null;
  error: string | null;
  diagnostic: ConnectionTestResult | null;
  initialKind: ServiceKind;
  open: boolean;
  revisionConnectionId: string | null;
  revisionHistory: ConfigurationRevisionList | null;
  onClose: () => void;
  onOpenAgenticSystem: () => void;
  onSave: (draft: ConnectionDraft) => Promise<void>;
  onTest: (id: string) => Promise<void>;
  onDiscoverInference: (input: InferenceDiscoveryRequest) => Promise<InferenceDiscoveryResult | null>;
  onLoadInferenceCatalogue: (input: InferenceCatalogueRequest) => Promise<InferenceCatalogueResult | null>;
  onUpdateMonitoring: (input: { enabled: boolean; intervalSeconds: number; reason: string }) => Promise<void>;
  onLoadRevisions: (connectionId: string) => Promise<void>;
  onRollback: (
    connectionId: string,
    targetRevision: number,
    expectedActiveRevision: number,
  ) => Promise<void>;
  /**
   * Setup step 1 owns this form. The dialog is the same editor for every other
   * surface; embedding it here is what keeps "connect inference" on the step
   * instead of in a popup over it.
   */
  embedded?: boolean;
}

function endpointOrigin(value: string | null | undefined): string | null {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

function configurationDefaults(
  fields: (typeof connectionDefinitions)[number]["configurationFields"],
): ServiceConnectionConfiguration {
  return Object.fromEntries(
    fields
      .filter(({ defaultValue }) => defaultValue !== undefined)
      .map(({ name, defaultValue }) => [name, defaultValue]),
  ) as ServiceConnectionConfiguration;
}

type InferenceEndpointMode = "local" | "openrouter";

function openRouterConfiguration(
  current: ServiceConnectionConfiguration,
): ServiceConnectionConfiguration {
  return {
    ...current,
    inferenceBackend: "CUSTOM_OPENAI_COMPATIBLE",
    modelsPath: OPENROUTER_INFERENCE.modelsPath,
    healthPath: OPENROUTER_INFERENCE.modelsPath,
    chatPath: OPENROUTER_INFERENCE.chatPath,
  };
}

function discoveryTone(status: InferenceDiscoveryResult["status"]) {
  if (status === "READY") return "good" as const;
  if (status === "UNREACHABLE") return "error" as const;
  return "warn" as const;
}

function kindCopy(kind: ServiceKind, existing: boolean): { title: string; description: string } {
  if (kind === "INFERENCE") {
    return {
      title: existing ? "Update AI Inference" : "Connect a model server",
      description: existing
        ? "Change the address or credentials. Discovery never turns off a connection that is already serving chat."
        : "Paste its address. OrcaSynapse discovers the backend and available models automatically.",
    };
  }
  return {
    title: existing ? "Update Enterprise Access" : "Connect Enterprise Access",
    description: "Issuer, client, and the groups that may sign in. Access fails closed if no group matches.",
  };
}

function TabButton(props: {
  selected: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      role="tab"
      aria-selected={props.selected}
      className={cn(
        "h-9 rounded-none border-x-0 border-t-0 border-b-2 px-3 shadow-none",
        props.selected
          ? "border-primary bg-transparent text-foreground hover:bg-transparent"
          : "border-transparent bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground",
      )}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function EndpointOption(props: {
  selected: boolean;
  icon: ReactNode;
  kicker: string;
  title: string;
  caption: string;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={props.selected}
      variant="outline"
      size="auto"
      className={cn(
        "h-full min-h-[10.5rem] w-full flex-col items-start justify-start gap-3 whitespace-normal rounded-lg p-4 text-left font-normal shadow-none",
        props.selected
          ? "border-accent bg-soft text-foreground hover:bg-soft hover:text-foreground"
          : "border-border bg-raised text-muted-foreground hover:border-border-strong hover:bg-raised hover:text-foreground",
      )}
      onClick={props.onSelect}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <Mark className={props.selected ? undefined : "bg-secondary text-muted-foreground"}>
          {props.icon}
        </Mark>
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border",
            props.selected ? "border-accent bg-accent" : "border-border-strong bg-transparent",
          )}
        />
      </span>
      <span className="grid min-w-0 gap-1">
        <MicroLabel className={props.selected ? "text-accent" : undefined}>{props.kicker}</MicroLabel>
        <span className="block font-display text-[16px] font-semibold tracking-[-0.02em] text-text">{props.title}</span>
        <span className="block text-caption font-medium leading-snug text-muted">{props.caption}</span>
      </span>
    </Button>
  );
}

export function ConnectionDrawer(props: ConnectionDrawerProps) {
  const [selectedKind, setSelectedKind] = useState<ServiceKind>(props.initialKind);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [environment, setEnvironment] = useState<Environment>("PRODUCTION");
  const [enabled, setEnabled] = useState(false);
  const [configuration, setConfiguration] = useState<ServiceConnectionConfiguration>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [rollbackCandidate, setRollbackCandidate] = useState<number | null>(null);
  const [monitoringEnabled, setMonitoringEnabled] = useState(false);
  const [monitoringInterval, setMonitoringInterval] = useState(300);
  const [monitoringReason, setMonitoringReason] = useState("Enable scheduled credential-aware checks.");
  const [inferenceDiscovery, setInferenceDiscovery] = useState<InferenceDiscoveryResult | null>(null);
  const [inferenceEndpointMode, setInferenceEndpointMode] = useState<InferenceEndpointMode>("local");
  const [openRouterCatalogue, setOpenRouterCatalogue] = useState<InferenceCatalogueResult | null>(null);

  const definition = useMemo(
    () => connectionDefinitions.find(({ kind }) => kind === selectedKind) ?? connectionDefinitions[0]!,
    [selectedKind],
  );
  const existing = props.connections.find(({ kind }) => kind === selectedKind);
  /*
   * What the seeding effect below actually depends on, as a value rather than an
   * object reference.
   *
   * `props.connections` is re-parsed from the API every 15 seconds and handed
   * down as a brand-new array, so `.find()` returns a new object every tick even
   * when nothing about the connection changed. Depending on that object meant
   * `Object.is` failed on every poll and the effect re-seeded twelve pieces of
   * state underneath whoever was typing: the API key field blanked, the
   * "Verify key and load models" button greyed out because it is disabled on
   * empty, the loaded model list vanished, and any typed configuration was
   * replaced by defaults. A rotated secret pasted in and not yet saved was
   * simply lost.
   *
   * `updatedAt` is the server's own marker for "this row changed", which is
   * exactly the condition that should re-seed the form.
   */
  const existingKey = existing ? `${existing.id}:${existing.updatedAt}` : null;
  const diagnostic =
    existing && props.diagnostic?.connectionId === existing.id ? props.diagnostic : null;
  const storedInferenceKeyReusable = Boolean(
    existing?.secretFieldNames?.includes("apiKey") &&
    endpointOrigin(existing.baseUrl) === endpointOrigin(baseUrl),
  );
  const openRouterMode = selectedKind === "INFERENCE" && inferenceEndpointMode === "openrouter";
  const copy = kindCopy(selectedKind, Boolean(existing));
  const localNeedsDiscovery = selectedKind === "INFERENCE" && !openRouterMode && (
    !existing || (existing.baseUrl ?? "") !== baseUrl.trim()
  );
  const submitDisabled = props.busy || (localNeedsDiscovery && inferenceDiscovery?.status !== "READY");
  const submitLabel = props.busy
    ? selectedKind === "INFERENCE" && enabled ? "Saving and verifying…" : "Saving…"
    : selectedKind === "INFERENCE" && (inferenceDiscovery?.status === "READY" || openRouterCatalogue !== null)
      ? "Activate AI Inference"
      : existing ? "Save changes" : "Create connection";

  useEffect(() => setSelectedKind(props.initialKind), [props.initialKind]);

  useEffect(() => {
    setMonitoringEnabled(props.monitoring?.enabled ?? false);
    setMonitoringInterval(props.monitoring?.intervalSeconds ?? 300);
    setMonitoringReason(props.monitoring?.reason ?? "Enable scheduled credential-aware checks.");
  }, [props.monitoring]);

  useEffect(() => {
    setDisplayName(existing?.displayName ?? `${definition.name} Primary`);
    setSlug(existing?.slug ?? `${definition.name.toLowerCase().replace(/[^a-z0-9]/g, "")}-primary`);
    setBaseUrl(existing?.baseUrl ?? "");
    setEnvironment(existing?.environment ?? "PRODUCTION");
    setEnabled(existing?.enabled ?? false);
    setConfiguration({
      ...configurationDefaults(definition.configurationFields),
      ...(existing?.configuration ?? {}),
    });
    setSecrets({});
    setInferenceDiscovery(null);
    setInferenceEndpointMode(isOpenRouterEndpoint(existing?.baseUrl) ? "openrouter" : "local");
    setOpenRouterCatalogue(null);
    setRollbackCandidate(null);
    // `existingKey`, not `existing` -- see the note where it is derived. The
    // effect reads `existing`, and may: when the key is unchanged every field it
    // reads is equal by value, and when it changes the effect re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, existingKey]);

  if (!props.embedded && !props.open) return null;

  const submitConnection = (event: FormEvent) => {
    event.preventDefault();
    if (submitDisabled) return;
    const suppliedSecrets = Object.fromEntries(
      Object.entries(secrets).filter(([, value]) => value.trim().length > 0),
    );
    void props.onSave({
      ...(existing ? { existingId: existing.id } : {}),
      slug: slugify(slug),
      displayName,
      kind: selectedKind,
      environment,
      baseUrl: openRouterMode ? OPENROUTER_INFERENCE.origin : baseUrl.trim() || null,
      enabled,
      configuration: openRouterMode ? openRouterConfiguration(configuration) : configuration,
      secrets: suppliedSecrets,
    });
  };

  const selectInferenceMode = (mode: InferenceEndpointMode) => {
    if (mode === inferenceEndpointMode) return;
    setInferenceEndpointMode(mode);
    setInferenceDiscovery(null);
    setOpenRouterCatalogue(null);
    if (mode === "openrouter") {
      setBaseUrl(OPENROUTER_INFERENCE.origin);
      setConfiguration((current) => {
        const next = openRouterConfiguration(current);
        delete next.modelAlias;
        return next;
      });
      return;
    }
    setBaseUrl("");
    setConfiguration(configurationDefaults(definition.configurationFields));
  };

  const loadOpenRouterCatalogue = async () => {
    const apiKey = secrets.apiKey?.trim();
    if (!apiKey) return;
    const result = await props.onLoadInferenceCatalogue({
      provider: "openrouter",
      apiKey,
      timeoutMs: typeof configuration.timeoutMs === "number" ? configuration.timeoutMs : 8000,
    });
    if (!result) return;
    setOpenRouterCatalogue(result);
    setEnabled((current) => current || result.models.length > 0);
    setConfiguration((current) => openRouterConfiguration(current));
  };

  const discoverInference = async () => {
    if (!baseUrl.trim()) return;
    const apiKey = secrets.apiKey?.trim();
    const result = await props.onDiscoverInference({
      baseUrl: baseUrl.trim(),
      ...(existing ? { connectionId: existing.id } : {}),
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: typeof configuration.timeoutMs === "number" ? configuration.timeoutMs : 8000,
    });
    if (!result) return;

    setInferenceDiscovery(result);
    /*
     * Discovery may raise admission and must never lower it.
     *
     * This was `setEnabled(result.status === "READY")`, so a PARTIAL,
     * AUTH_REQUIRED or UNREACHABLE probe turned off a connection that was
     * serving chat a second earlier. Nothing downstream caught it: Save has no
     * gate on the discovery outcome, `app.tsx` reads `draft.enabled` to decide
     * whether this is an activation, and with it false it writes
     * `enabled: false` and skips the test-and-reactivate branch entirely -- no
     * health check, no message, and no `enabled` control anywhere on the
     * INFERENCE form to put it back. The only route out is "Test & activate",
     * which needs a HEALTHY test the operator now has to go and earn.
     *
     * The asymmetry is the point. A probe is evidence about one moment, from
     * this browser, through whatever sat in the path; admission is a decision
     * an administrator made. Evidence of health is enough to offer activation,
     * and the absence of it is not enough to withdraw one.
     */
    setEnabled((current) => current || result.status === "READY");
    setBaseUrl(result.recommended.baseUrl);
    setConfiguration((current) => {
      const next: ServiceConnectionConfiguration = {
        ...current,
        inferenceBackend: result.recommended.inferenceBackend,
        modelsPath: result.recommended.modelsPath,
        chatPath: result.recommended.chatPath,
      };
      if (result.recommended.healthPath) next.healthPath = result.recommended.healthPath;
      else delete next.healthPath;
      return next;
    });
  };

  const identityFields = (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Display name">
        <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength={2} />
      </Field>
      <Field label="Slug">
        <Input
          value={slug}
          onChange={(event) => setSlug(slugAsTyped(event.target.value))}
          onBlur={() => setSlug((current) => slugify(current))}
          required
          disabled={Boolean(existing)}
        />
      </Field>
      <Field className="sm:col-span-2" label={definition.endpointLabel ?? "Endpoint URL"}>
        <Input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://service.orcasynapse.internal"
        />
      </Field>
      <Field label="Environment">
        <Select value={environment} onChange={(event) => setEnvironment(event.target.value as Environment)}>
          <option value="DEVELOPMENT">Development</option>
          <option value="STAGING">Staging</option>
          <option value="PRODUCTION">Production</option>
        </Select>
      </Field>
      <div className="flex items-center gap-3 sm:self-end sm:pb-1">
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable after saving" />
        <span className="text-body text-foreground">Enable after saving</span>
      </div>
    </div>
  );


  const form = (
      <form id="connection-form" className="grid gap-5" onSubmit={submitConnection}>
        {props.embedded ? null : (
        <div className="-mx-1 flex gap-1 border-b border-border" role="tablist" aria-label="Connection type">
          {connectionDefinitions.filter(({ kind }) => kind === "INFERENCE").map((item) => (
            <TabButton key={item.kind} selected={selectedKind === item.kind} onClick={() => setSelectedKind(item.kind)}>
              {item.name}
            </TabButton>
          ))}
          <TabButton selected={false} onClick={props.onOpenAgenticSystem}>Agentic System</TabButton>
        </div>
        )}

        {props.error ? <Alert>{props.error}</Alert> : null}

        {existing ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <StatusText tone={toneFor((diagnostic?.status ?? existing.status).toLowerCase())} dot>
                {diagnostic
                  ? diagnostic.status.replaceAll("_", " ")
                  : existing.enabled && existing.status === "HEALTHY" ? "Connected and active" : existing.status.replaceAll("_", " ")}
              </StatusText>
              {/*
                * The endpoint sits on the status line rather than in a tile
                * above it. Setup drew both: a card naming the endpoint with a
                * readiness dot, and this block naming the same connection's
                * status with its own dot -- two components reporting one
                * connection, stacked, each with half the answer. One line now
                * says which endpoint, whether it is healthy, and what the last
                * check reported, beside the button that runs the next one.
                */}
              {existing.baseUrl ? (
                <p className="mt-1 truncate font-mono text-micro text-faint">{existing.baseUrl}</p>
              ) : null}
              <p className="mt-1 text-caption leading-relaxed text-muted">
                {diagnostic?.message ?? existing.lastHealthcheckMessage ?? "Run a credential-aware health check."}
                {diagnostic ? ` · ${diagnostic.latencyMs} ms` : ""}
              </p>
            </div>
            <Button size="sm" disabled={props.busy} onClick={() => void props.onTest(existing.id)}>
              {props.busy
                ? existing.kind === "INFERENCE" && !existing.enabled ? "Testing and activating…" : "Testing…"
                : existing.kind === "INFERENCE" && !existing.enabled ? "Test & activate" : "Test connection"}
            </Button>
          </div>
        ) : null}

        {selectedKind === "INFERENCE" ? (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <MicroLabel>Choose an endpoint</MicroLabel>
              <div role="radiogroup" aria-label="Endpoint type" className="grid gap-3 sm:grid-cols-2">
                <EndpointOption
                  selected={!openRouterMode}
                  icon={<Server className="size-4" />}
                  kicker="On your network"
                  title="Local server"
                  caption="vLLM, llama.cpp, SGLang, Ollama, or TGI. Discovery stays on this host."
                  onSelect={() => selectInferenceMode("local")}
                />
                <EndpointOption
                  selected={openRouterMode}
                  icon={<Globe className="size-4" />}
                  kicker="Public endpoint"
                  title="OpenRouter"
                  caption="Hosted models. Verify a key to confirm the catalogue answers."
                  onSelect={() => selectInferenceMode("openrouter")}
                />
              </div>
            </div>

            {openRouterMode ? (
              <>
                <Alert tone="warn">
                  Prompts and completions leave this environment. OpenRouter and its downstream providers receive every
                  message sent through this connection.
                </Alert>
                <Field
                  label="OpenRouter API key"
                  hint={storedInferenceKeyReusable ? "Stored key will be used if this is left blank." : "Required. OrcaSynapse stores it on VM1 and never sends it to Hermes."}
                >
                  <Input
                    type="password"
                    value={secrets.apiKey ?? ""}
                    onChange={(event) => {
                      setSecrets((current) => ({ ...current, apiKey: event.target.value }));
                      setOpenRouterCatalogue(null);
                    }}
                    required={!storedInferenceKeyReusable}
                    autoComplete="new-password"
                    placeholder={storedInferenceKeyReusable ? "Leave blank to use stored key" : "sk-or-v1-…"}
                  />
                </Field>
                <div>
                  <Button
                    variant="primary"
                    disabled={props.busy || (secrets.apiKey?.trim().length ?? 0) === 0}
                    onClick={() => void loadOpenRouterCatalogue()}
                  >
                    {props.busy ? "Loading models…" : "Verify key and load models"}
                  </Button>
                </div>
                {openRouterCatalogue ? (
                  <Alert tone="good">
                    <span className="block font-semibold">
                      {openRouterCatalogue.models.length} models available
                      {openRouterCatalogue.key.label ? ` · ${openRouterCatalogue.key.label}` : ""}
                    </span>
                    {openRouterCatalogue.key.limitRemaining !== undefined && openRouterCatalogue.key.limitRemaining !== null ? (
                      <span className="mt-1 block text-caption opacity-80">
                        {openRouterCatalogue.key.limitRemaining} credits remaining on this key
                      </span>
                    ) : null}
                    <span className="mt-1 block text-caption opacity-80">
                      Activate a default Agent model on Gateway → Models.
                    </span>
                  </Alert>
                ) : null}
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <Field label="AI Inference address" htmlFor="inference-address">
                      <Input
                        id="inference-address"
                        type="text"
                        inputMode="url"
                        value={baseUrl}
                        onChange={(event) => {
                          setBaseUrl(event.target.value);
                          setInferenceDiscovery(null);
                        }}
                        placeholder="http://gpu-server.internal:8000 or .../v1"
                        required
                      />
                    </Field>
                    <Button
                      variant="primary"
                      disabled={props.busy || baseUrl.trim().length === 0}
                      onClick={() => void discoverInference()}
                    >
                      {props.busy ? "Discovering…" : "Discover server"}
                    </Button>
                  </div>
                  <p className="text-caption leading-relaxed text-muted">
                    Paste the address you already use. Discover reads the backend and API paths from the server — they are not typed here.
                  </p>
                  {localNeedsDiscovery && inferenceDiscovery?.status !== "READY" ? (
                    <p className="text-caption leading-relaxed text-warn">
                      Discover the server before saving. A guessed `/v1` path will not match every engine.
                    </p>
                  ) : null}
                </div>
                <Field
                  label="API key"
                  hint={storedInferenceKeyReusable ? "Stored key will be used if this is left blank." : "Optional. Enter only if the server requires one."}
                >
                  <Input
                    type="password"
                    value={secrets.apiKey ?? ""}
                    onChange={(event) => {
                      setSecrets((current) => ({ ...current, apiKey: event.target.value }));
                      setInferenceDiscovery(null);
                    }}
                    autoComplete="new-password"
                    placeholder={storedInferenceKeyReusable ? "Leave blank to use stored key" : "Enter only if the server requires one"}
                  />
                </Field>

                {inferenceDiscovery ? (
                  <div className="grid gap-3">
                    <Alert tone={discoveryTone(inferenceDiscovery.status)}>
                      <span className="block font-semibold">{inferenceDiscovery.message}</span>
                      <span className="mt-1 block text-caption opacity-80">
                        {inferenceDiscovery.status.replaceAll("_", " ")}
                        {" · "}
                        {inferenceEndpointPresets.find(({ backend }) => backend === inferenceDiscovery.backend)?.label ?? "OpenAI compatible"}
                        {" · "}
                        {inferenceDiscovery.models.length} model{inferenceDiscovery.models.length === 1 ? "" : "s"}
                        {" · normalized to "}
                        {inferenceDiscovery.normalizedBaseUrl}
                      </span>
                    </Alert>
                    <details className="text-caption text-muted">
                      <summary className="cursor-pointer font-semibold text-foreground">View discovery evidence</summary>
                      <div className="mt-2 grid gap-1.5">
                        {inferenceDiscovery.backendEvidence.map((item) => <p key={item} className="m-0">{item}</p>)}
                        {inferenceDiscovery.probes.map((probe) => (
                          <p key={probe.key} className="m-0">
                            {probe.status === "PASSED" ? "Passed" : probe.status === "WARNING" ? "Warning" : "Failed"}
                            {": "}
                            {probe.label}
                            {" · "}
                            {probe.path}
                            {" · "}
                            {probe.httpStatus ?? "No response"}
                            {" · "}
                            {probe.latencyMs}
                            {" ms"}
                          </p>
                        ))}
                      </div>
                    </details>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : identityFields}

        {/*
          * Gated on the connection existing, not on its kind.
          *
          * This read `existing && selectedKind === "OIDC"`, which was never
          * about OIDC -- revisions are a property every connection has, and
          * `onLoadRevisions` takes a connection id. With the federated identity
          * form removed the kind test could only ever be false, so the choice
          * was to delete a working feature or to state the condition it always
          * meant. Configuration history now shows for any saved connection.
          */}
        {existing ? (
          <section className="grid gap-3" aria-labelledby="revision-history-title">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p id="revision-history-title" className="text-label font-semibold text-foreground">Configuration history</p>
                <p className="text-caption text-muted">Credentials are never restored from an older revision.</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={props.busy}
                onClick={() => void props.onLoadRevisions(existing.id)}
              >
                {props.revisionConnectionId === existing.id ? "Refresh history" : "View history"}
              </Button>
            </div>
            {props.revisionConnectionId === existing.id && props.revisionHistory ? (
              <div className="grid gap-2">
                {props.revisionHistory.items.map((revision) => (
                  <article key={revision.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-body font-semibold text-foreground">
                        {revision.displayName} · revision {revision.revision}
                      </p>
                      <p className="text-caption text-muted">
                        {revision.active
                          ? "Active configuration"
                          : `${revision.environment.toLowerCase()} · ${revision.enabled ? "enabled" : "disabled"} · ${new Date(revision.createdAt).toLocaleString()}`}
                      </p>
                      <p className="text-caption text-faint">{revision.baseUrl ?? "No endpoint configured"}</p>
                    </div>
                    {revision.active ? (
                      <StatusText tone="good">Active</StatusText>
                    ) : rollbackCandidate === revision.revision ? (
                      <div className="grid max-w-[240px] justify-items-end gap-2 text-right text-caption text-warn">
                        <span>Restore settings from this revision while keeping current credentials?</span>
                        <div className="flex gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setRollbackCandidate(null)}>Cancel</Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={props.busy}
                            onClick={() => {
                              setRollbackCandidate(null);
                              void props.onRollback(
                                existing.id,
                                revision.revision,
                                props.revisionHistory!.activeRevision,
                              );
                            }}
                          >
                            Confirm restore
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button size="sm" disabled={props.busy} onClick={() => setRollbackCandidate(revision.revision)}>
                        Restore
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/*
          * Last, not first. This is an optional scheduled health check and it
          * opened the modal -- above the connection it monitors, and above the
          * fields an operator came here to fill in. Its own summary says
          * "Optional"; it now sits where optional things belong.
          */}
        <details className="group border-t border-border pt-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <span>
              <span className="block text-label font-semibold text-foreground">Connection monitoring</span>
              <span className="block text-caption text-muted">Optional scheduled health checks</span>
            </span>
            <span className="flex items-center gap-2">
              <StatusText tone={monitoringEnabled ? "good" : "neutral"}>{monitoringEnabled ? "On" : "Off"}</StatusText>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </span>
          </summary>
          <div className="mt-4 grid gap-3">
            <p className="text-caption leading-relaxed text-muted">
              Checks use encrypted connector credentials inside OrcaSynapse and never expose them to the browser.
            </p>
            <div className="flex items-center gap-3">
              <Switch
                checked={monitoringEnabled}
                onCheckedChange={setMonitoringEnabled}
                aria-label="Run scheduled checks"
              />
              <span className="text-body text-foreground">Run scheduled checks</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Cadence">
                <Select value={monitoringInterval} onChange={(event) => setMonitoringInterval(Number(event.target.value))}>
                  <option value={60}>Every minute</option>
                  <option value={300}>Every 5 minutes</option>
                  <option value={900}>Every 15 minutes</option>
                  <option value={3600}>Every hour</option>
                </Select>
              </Field>
              <Field label="Operator reason">
                <Input minLength={3} maxLength={500} value={monitoringReason} onChange={(event) => setMonitoringReason(event.target.value)} />
              </Field>
            </div>
            <div>
              <Button
                variant="primary"
                type="button"
                disabled={props.busy || monitoringReason.trim().length < 3}
                onClick={() => void props.onUpdateMonitoring({
                  enabled: monitoringEnabled,
                  intervalSeconds: monitoringInterval,
                  reason: monitoringReason.trim(),
                })}
              >
                {props.busy ? "Applying…" : "Save monitoring"}
              </Button>
            </div>
          </div>
        </details>
        {props.embedded ? (
          <div className="flex justify-end">
            <Button variant="primary" type="submit" disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </div>
        ) : null}
      </form>
  );

  if (props.embedded) {
    return form;
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      icon={selectedKind === "INFERENCE" ? Cpu : Shield}
      title={copy.title}
      description={copy.description}
      className="max-w-[560px]"
      footer={
        <>
          <Button type="button" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="connection-form" disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {form}
    </Dialog>
  );
}
