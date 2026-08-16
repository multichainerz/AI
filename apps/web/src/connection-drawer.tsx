import type {
  CreateServiceConnection,
  ConnectionMonitoringControl,
  ConnectionTestResult,
  ConfigurationRevisionList,
  Environment,
  InferenceDiscoveryRequest,
  InferenceDiscoveryResult,
  ServiceConnectionConfiguration,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { slugAsTyped, slugify } from "./slug.js";
import { connectionDefinitions, inferenceEndpointPresets } from "./connection-definitions.js";
import { Alert, Button, Dialog, Field, Input, Select, StatusText, toneFor } from "./ui/index.js";
import { Separator } from "@/components/ui/separator";
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
  onUpdateMonitoring: (input: { enabled: boolean; intervalSeconds: number; reason: string }) => Promise<void>;
  onLoadRevisions: (connectionId: string) => Promise<void>;
  onRollback: (
    connectionId: string,
    targetRevision: number,
    expectedActiveRevision: number,
  ) => Promise<void>;
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
        ? "Change the address, model, or credentials. Discovery never turns off a connection that is already serving chat."
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
  const [inferenceAdvancedOpen, setInferenceAdvancedOpen] = useState(false);

  const definition = useMemo(
    () => connectionDefinitions.find(({ kind }) => kind === selectedKind) ?? connectionDefinitions[0]!,
    [selectedKind],
  );
  const existing = props.connections.find(({ kind }) => kind === selectedKind);
  const diagnostic =
    existing && props.diagnostic?.connectionId === existing.id ? props.diagnostic : null;
  const inferenceBackend = configuration.inferenceBackend ?? "CUSTOM_OPENAI_COMPATIBLE";
  const inferencePreset = inferenceEndpointPresets.find(({ backend }) => backend === inferenceBackend)
    ?? inferenceEndpointPresets.at(-1)!;
  const storedInferenceKeyReusable = Boolean(
    existing?.secretFieldNames.includes("apiKey") &&
    endpointOrigin(existing.baseUrl) === endpointOrigin(baseUrl),
  );
  const operationalFields = definition.configurationFields.filter(
    ({ name }) => selectedKind !== "INFERENCE" || name !== "inferenceBackend",
  );
  const copy = kindCopy(selectedKind, Boolean(existing));
  const showAdvanced = selectedKind !== "INFERENCE" || inferenceAdvancedOpen;
  const submitLabel = props.busy
    ? selectedKind === "INFERENCE" && enabled ? "Saving and verifying…" : "Saving…"
    : selectedKind === "INFERENCE" && inferenceDiscovery?.status === "READY"
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
    setInferenceAdvancedOpen(false);
    setRollbackCandidate(null);
  }, [definition, existing]);

  if (!props.open) return null;

  const submitConnection = (event: FormEvent) => {
    event.preventDefault();
    const suppliedSecrets = Object.fromEntries(
      Object.entries(secrets).filter(([, value]) => value.trim().length > 0),
    );
    void props.onSave({
      ...(existing ? { existingId: existing.id } : {}),
      slug: slugify(slug),
      displayName,
      kind: selectedKind,
      environment,
      baseUrl: baseUrl.trim() || null,
      enabled,
      configuration,
      secrets: suppliedSecrets,
    });
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
        ...(result.recommended.modelAlias ? { modelAlias: result.recommended.modelAlias } : {}),
      };
      if (result.recommended.healthPath) next.healthPath = result.recommended.healthPath;
      else delete next.healthPath;
      return next;
    });
  };

  const setConfigValue = (name: keyof ServiceConnectionConfiguration, value: string | number | boolean | string[] | undefined) => {
    setConfiguration((current) => {
      const next: Record<string, string | number | boolean | string[] | undefined> = { ...current };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next as ServiceConnectionConfiguration;
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
      {selectedKind !== "INFERENCE" ? (
        <Field className="sm:col-span-2" label={definition.endpointLabel ?? "Endpoint URL"}>
          <Input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={selectedKind === "OIDC" ? "https://identity.orcasynapse.internal" : "https://service.orcasynapse.internal"}
          />
        </Field>
      ) : null}
      <Field label="Environment">
        <Select value={environment} onChange={(event) => setEnvironment(event.target.value as Environment)}>
          <option value="DEVELOPMENT">Development</option>
          <option value="STAGING">Staging</option>
          <option value="PRODUCTION">Production</option>
        </Select>
      </Field>
      {selectedKind !== "INFERENCE" ? (
        <div className="flex items-center gap-3 sm:self-end sm:pb-1">
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable after saving" />
          <span className="text-body text-foreground">Enable after saving</span>
        </div>
      ) : null}
    </div>
  );

  const configurationFields = (
    <div className="grid gap-3 sm:grid-cols-2">
      {selectedKind === "INFERENCE" ? (
        <Field className="sm:col-span-2" label="Serving implementation" hint={inferencePreset.description}>
          <Select
            value={inferenceBackend}
            onChange={(event) => setConfigValue("inferenceBackend", event.target.value)}
          >
            {inferenceEndpointPresets.map((preset) => (
              <option key={preset.backend} value={preset.backend}>{preset.label}</option>
            ))}
          </Select>
        </Field>
      ) : null}
      {operationalFields.map((field) => {
        const value = configuration[field.name];
        if (field.type === "checkbox") {
          return (
            <div key={field.name} className="flex items-start gap-3 sm:col-span-2">
              <Switch
                className="mt-0.5"
                checked={value === true}
                onCheckedChange={(checked) => setConfigValue(field.name, checked)}
                aria-label={field.label}
              />
              <span>
                <span className="block text-body font-semibold text-foreground">{field.label}</span>
                <span className="block text-caption text-muted">{field.help}</span>
              </span>
            </div>
          );
        }
        if (field.type === "select") {
          return (
            <Field key={field.name} label={field.label} hint={field.help}>
              <Select
                value={typeof value === "string" ? value : ""}
                onChange={(event) => setConfigValue(field.name, event.target.value)}
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </Field>
          );
        }
        return (
          <Field key={field.name} label={field.label} hint={field.help}>
            <Input
              type={field.type === "text-list" ? "text" : field.type}
              value={field.type === "text-list" && Array.isArray(value)
                ? value.join(", ")
                : typeof value === "string" || typeof value === "number" ? value : ""}
              placeholder={field.placeholder}
              required={field.required}
              min={field.type === "number" ? (field.min ?? 1000) : undefined}
              max={field.type === "number" ? (field.max ?? 30000) : undefined}
              step={field.type === "number" ? (field.step ?? 500) : undefined}
              onChange={(event) => {
                const nextValue = event.target.value;
                if (nextValue.length === 0) {
                  setConfigValue(field.name, undefined);
                  return;
                }
                setConfigValue(
                  field.name,
                  field.type === "number"
                    ? Number(nextValue)
                    : field.type === "text-list"
                      ? [...new Set(nextValue.split(",").map((item) => item.trim()).filter(Boolean))]
                      : nextValue,
                );
              }}
            />
          </Field>
        );
      })}
    </div>
  );

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={copy.title}
      description={copy.description}
      className="max-w-[560px]"
      footer={
        <>
          <Button type="button" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="connection-form" disabled={props.busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="connection-form" className="grid gap-5" onSubmit={submitConnection}>
        <div className="-mx-1 flex gap-1 border-b border-border" role="tablist" aria-label="Connection type">
          {connectionDefinitions.filter(({ kind }) => kind === "INFERENCE").map((item) => (
            <TabButton key={item.kind} selected={selectedKind === item.kind} onClick={() => setSelectedKind(item.kind)}>
              {item.name}
            </TabButton>
          ))}
          <TabButton selected={false} onClick={props.onOpenAgenticSystem}>Agentic System</TabButton>
          {connectionDefinitions.filter(({ kind }) => kind === "OIDC").map((item) => (
            <TabButton key={item.kind} selected={selectedKind === item.kind} onClick={() => setSelectedKind(item.kind)}>
              {item.name}
            </TabButton>
          ))}
        </div>

        {props.error ? <Alert>{props.error}</Alert> : null}

        {existing ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <StatusText tone={toneFor((diagnostic?.status ?? existing.status).toLowerCase())} dot>
                {diagnostic
                  ? diagnostic.status.replaceAll("_", " ")
                  : existing.enabled && existing.status === "HEALTHY" ? "Connected and active" : existing.status.replaceAll("_", " ")}
              </StatusText>
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
                Paste the address you already use. OrcaSynapse safely normalizes `/v1`, `/v1/models`, and similar paths.
              </p>
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
                {inferenceDiscovery.models.length > 0 ? (
                  <Field label="Model OrcaSynapse should use" hint="Loaded from the server; nothing needs to be typed.">
                    <Select
                      value={configuration.modelAlias ?? inferenceDiscovery.models[0]?.id ?? ""}
                      onChange={(event) => setConfigValue("modelAlias", event.target.value)}
                    >
                      {inferenceDiscovery.models.map(({ id }) => <option key={id} value={id}>{id}</option>)}
                    </Select>
                  </Field>
                ) : null}
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
          </div>
        ) : identityFields}

        {selectedKind === "INFERENCE" ? (
          <Button
            variant="ghost"
            className="h-auto justify-between px-0 text-left"
            aria-expanded={inferenceAdvancedOpen}
            onClick={() => setInferenceAdvancedOpen((current) => !current)}
          >
            <span>
              <span className="block text-label font-semibold text-foreground">Advanced configuration</span>
              <span className="block text-caption font-normal text-muted">Manual backend, paths, limits, and timeouts</span>
            </span>
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", inferenceAdvancedOpen && "rotate-180")} />
          </Button>
        ) : null}

        {showAdvanced ? (
          <div className="grid gap-4">
            {selectedKind === "INFERENCE" ? identityFields : null}
            {selectedKind !== "INFERENCE" ? <Separator /> : null}
            {selectedKind !== "INFERENCE" ? (
              <p className="text-micro font-semibold uppercase tabular-nums text-faint">Operational settings</p>
            ) : null}
            {configurationFields}
          </div>
        ) : null}

        {selectedKind !== "INFERENCE" ? (
          <div className="grid gap-3">
            <p className="text-micro font-semibold uppercase tabular-nums text-faint">Credentials</p>
            {definition.secretFields.map((field) => {
              const stored = existing?.secretFieldNames.includes(field.name) ?? false;
              return (
                <Field
                  key={field.name}
                  label={field.label}
                  {...(stored ? { hint: "Stored — leave blank to keep." } : {})}
                >
                  <Input
                    type="password"
                    value={secrets[field.name] ?? ""}
                    onChange={(event) => setSecrets((current) => ({ ...current, [field.name]: event.target.value }))}
                    required={!existing && field.required}
                    autoComplete="new-password"
                    placeholder={stored ? "••••••••••••" : "Enter credential"}
                  />
                </Field>
              );
            })}
          </div>
        ) : null}

        {existing && showAdvanced ? (
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
      </form>
    </Dialog>
  );
}
