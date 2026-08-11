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
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { slugAsTyped, slugify } from "./slug.js";
import { connectionDefinitions, inferenceEndpointPresets } from "./connection-definitions.js";
import { Button, Drawer } from "./ui/index.js";

export interface ConnectionDraft extends CreateServiceConnection {
  existingId?: string;
}

/*
 * Sign-in, recovery and the forced password change used to be branches of this
 * drawer, because it was the only surface a signed-out operator could reach.
 * The front page owns the signed-out world now and `AdminSignInDialog` owns
 * elevation from inside the shell, so this drawer is purely what its name
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

  useEffect(() => setSelectedKind(props.initialKind), [props.initialKind]);

  useEffect(() => {
    setMonitoringEnabled(props.monitoring?.enabled ?? false);
    setMonitoringInterval(props.monitoring?.intervalSeconds ?? 300);
    setMonitoringReason(props.monitoring?.reason ?? "Enable scheduled credential-aware checks.");
  }, [props.monitoring]);

  /*
   * The focus trap that used to live here is gone: `Drawer` was extracted from
   * this exact implementation in v1.1.0, and keeping a second copy meant
   * two places to fix when one of them was wrong.
   */

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
    setEnabled(result.status === "READY");
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

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      kicker="Platform setup"
      title="Connect your AI stack"
      className="max-w-[640px]"
    >
      <div className="grid gap-4">
        {(
          <form className="connection-form" onSubmit={submitConnection}>
            <details className="drawer-operations-details">
              <summary>
                <span><strong>Connection monitoring</strong><small>Optional scheduled health checks</small></span>
                <em>{monitoringEnabled ? "On" : "Off"}</em>
              </summary>
              <section className={`monitoring-control ${monitoringEnabled ? "enabled" : "disabled"}`} aria-label="Scheduled connection monitoring">
              <div>
                <small>Continuous health evidence</small>
                <strong>{monitoringEnabled ? "Scheduled monitoring enabled" : "Scheduled monitoring disabled"}</strong>
                <span>Checks use encrypted connector credentials inside OrcaSynapse and never expose them to the browser.</span>
              </div>
              <label className="monitoring-toggle"><input type="checkbox" checked={monitoringEnabled} onChange={(event) => setMonitoringEnabled(event.target.checked)} /><span>Run scheduled checks</span></label>
              <label>Cadence
                <select value={monitoringInterval} onChange={(event) => setMonitoringInterval(Number(event.target.value))}>
                  <option value={60}>Every minute</option>
                  <option value={300}>Every 5 minutes</option>
                  <option value={900}>Every 15 minutes</option>
                  <option value={3600}>Every hour</option>
                </select>
              </label>
              <label className="sm:col-span-2">Operator reason
                <input minLength={3} maxLength={500} value={monitoringReason} onChange={(event) => setMonitoringReason(event.target.value)} />
              </label>
              <Button variant="primary"
                type="button"
                disabled={props.busy || monitoringReason.trim().length < 3}
                onClick={() => void props.onUpdateMonitoring({
                  enabled: monitoringEnabled,
                  intervalSeconds: monitoringInterval,
                  reason: monitoringReason.trim(),
                })}
              >{props.busy ? "Applying…" : "Save monitoring"}</Button>
              </section>
            </details>
            <div className="kind-tabs" role="tablist" aria-label="Connection type">
              {connectionDefinitions.filter(({ kind }) => kind === "INFERENCE").map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="tab"
                  aria-selected={selectedKind === item.kind}
                  className={selectedKind === item.kind ? "selected" : ""}
                  onClick={() => setSelectedKind(item.kind)}
                >{item.name}</button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected="false"
                onClick={props.onOpenAgenticSystem}
              >Agentic System</button>
              {connectionDefinitions.filter(({ kind }) => kind === "OIDC").map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="tab"
                  aria-selected={selectedKind === item.kind}
                  className={selectedKind === item.kind ? "selected" : ""}
                  onClick={() => setSelectedKind(item.kind)}
                >{item.name}</button>
              ))}
            </div>

            <div className="form-heading">
              <div className={`connection-mark ${definition.tone}`}>{definition.name.slice(0, 2).toUpperCase()}</div>
              <div><h3>{existing ? `Update ${definition.name}` : `Connect ${definition.name}`}</h3><p>{definition.role}</p></div>
              {existing && <span className="saved-badge">Saved</span>}
            </div>

            {existing && (
              <div className={`diagnostic-result ${(diagnostic?.status ?? existing.status).toLowerCase()}`}>
                <div>
                  <strong>{diagnostic
                    ? diagnostic.status
                    : existing.enabled && existing.status === "HEALTHY" ? "Connected and active" : existing.status.replaceAll("_", " ")}</strong>
                  <span>{diagnostic?.message ?? existing.lastHealthcheckMessage ?? "Run a credential-aware health check."}</span>
                </div>
                {diagnostic && <small>{diagnostic.latencyMs} ms</small>}
                <button type="button" disabled={props.busy} onClick={() => void props.onTest(existing.id)}>
                  {props.busy
                    ? existing.kind === "INFERENCE" && !existing.enabled ? "Testing and activating…" : "Testing…"
                    : existing.kind === "INFERENCE" && !existing.enabled ? "Test & activate" : "Test connection"}
                </button>
              </div>
            )}

            {selectedKind !== "INFERENCE" && <div className="form-grid">
              <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength={2}/></label>
              <label>Slug<input value={slug} onChange={(event) => setSlug(slugAsTyped(event.target.value))} onBlur={() => setSlug((current) => slugify(current))} required disabled={Boolean(existing)}/></label>
              <label className="sm:col-span-2">{definition.endpointLabel ?? "Endpoint URL"}<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selectedKind === "OIDC" ? "https://identity.orcasynapse.internal" : "https://service.orcasynapse.internal"}/></label>
              <label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value as Environment)}><option value="DEVELOPMENT">Development</option><option value="STAGING">Staging</option><option value="PRODUCTION">Production</option></select></label>
              <label className="switch-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span>Enable after saving</span></label>
            </div>}

            {selectedKind === "INFERENCE" && <section className="inference-discovery-section" aria-labelledby="inference-discovery-title">
              <header>
                <div><small>AI Inference</small><strong id="inference-discovery-title">Connect a model server</strong><span>Paste its address. OrcaSynapse discovers the backend and available models automatically.</span></div>
              </header>
              <div className="inference-connect-grid">
                <label>AI Inference address
                  <input
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
                  <small>Paste the address you already use. OrcaSynapse safely normalizes `/v1`, `/v1/models`, and similar paths.</small>
                </label>
                <label>API key
                  <span className="secret-input-label">{storedInferenceKeyReusable ? "Stored key will be used" : "Optional"}</span>
                  <input
                    type="password"
                    value={secrets.apiKey ?? ""}
                    onChange={(event) => {
                      setSecrets((current) => ({ ...current, apiKey: event.target.value }));
                      setInferenceDiscovery(null);
                    }}
                    autoComplete="new-password"
                    placeholder={storedInferenceKeyReusable ? "Leave blank to use stored key" : "Enter only if the server requires one"}
                  />
                </label>
                <button
                  className="primary-button inference-discover-button"
                  type="button"
                  disabled={props.busy || baseUrl.trim().length === 0}
                  onClick={() => void discoverInference()}
                >{props.busy ? "Discovering…" : "Discover server"}</button>
              </div>

              {inferenceDiscovery && <div className={`inference-discovery-result ${inferenceDiscovery.status.toLowerCase()}`}>
                <div className="inference-discovery-summary">
                  <span className="discovery-status-mark" aria-hidden="true">{inferenceDiscovery.status === "READY" ? "✓" : "!"}</span>
                  <div><small>{inferenceDiscovery.status.replaceAll("_", " ")}</small><strong>{inferenceDiscovery.message}</strong><span>Normalized to {inferenceDiscovery.normalizedBaseUrl}</span></div>
                  <em>{inferenceDiscovery.backendConfidence.toLowerCase()} confidence</em>
                </div>
                <div className="inference-discovery-facts">
                  <span><small>Implementation</small><strong>{inferenceEndpointPresets.find(({ backend }) => backend === inferenceDiscovery.backend)?.label ?? "OpenAI compatible"}</strong></span>
                  <span><small>Health</small><strong>{inferenceDiscovery.recommended.healthPath ?? "Model API"}</strong></span>
                  <span><small>Models found</small><strong>{inferenceDiscovery.models.length}</strong></span>
                </div>
                {inferenceDiscovery.models.length > 0 && <label className="discovered-model-select">Model OrcaSynapse should use
                  <select
                    value={configuration.modelAlias ?? inferenceDiscovery.models[0]?.id ?? ""}
                    onChange={(event) => setConfiguration((current) => ({ ...current, modelAlias: event.target.value }))}
                  >
                    {inferenceDiscovery.models.map(({ id }) => <option key={id} value={id}>{id}</option>)}
                  </select>
                  <small>Loaded directly from the server; no model name needs to be typed manually.</small>
                </label>}
                {inferenceDiscovery.status === "READY" && <div className="inference-activation-note">
                  <strong>Ready to activate</strong>
                  <span>Review the selected model, then activate below. OrcaSynapse will save, verify, and admit this endpoint in one operation.</span>
                </div>}
                <details className="discovery-evidence">
                  <summary>View discovery evidence</summary>
                  <div>
                    {inferenceDiscovery.backendEvidence.map((item) => <p key={item}>{item}</p>)}
                    {inferenceDiscovery.probes.map((probe) => <p key={probe.key} className={probe.status.toLowerCase()}><span>{probe.status === "PASSED" ? "✓" : probe.status === "WARNING" ? "!" : "×"}</span><strong>{probe.label}</strong><small>{probe.path} · {probe.httpStatus ?? "No response"} · {probe.latencyMs} ms</small></p>)}
                  </div>
                </details>
              </div>}
            </section>}

            {selectedKind === "INFERENCE" && <button
              className="advanced-configuration-toggle"
              type="button"
              aria-expanded={inferenceAdvancedOpen}
              onClick={() => setInferenceAdvancedOpen((current) => !current)}
            ><span><strong>Advanced configuration</strong><small>Manual backend, paths, limits, and timeouts</small></span><b>{inferenceAdvancedOpen ? "−" : "+"}</b></button>}

            {(selectedKind !== "INFERENCE" || inferenceAdvancedOpen) && <div className="configuration-section">
              <div><strong>Operational settings</strong><span>Validated non-secret values</span></div>
              {selectedKind === "INFERENCE" && <div className="form-grid inference-identity-grid">
                <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength={2}/></label>
                <label>Slug<input value={slug} onChange={(event) => setSlug(slugAsTyped(event.target.value))} onBlur={() => setSlug((current) => slugify(current))} required disabled={Boolean(existing)}/></label>
                <label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value as Environment)}><option value="DEVELOPMENT">Development</option><option value="STAGING">Staging</option><option value="PRODUCTION">Production</option></select></label>
              </div>}
              <div className="configuration-grid">
                {selectedKind === "INFERENCE" && <label>Serving implementation
                  <select
                    value={inferenceBackend}
                    onChange={(event) => setConfiguration((current) => ({
                      ...current,
                      inferenceBackend: event.target.value as typeof inferenceBackend,
                    }))}
                  >
                    {inferenceEndpointPresets.map((preset) => <option key={preset.backend} value={preset.backend}>{preset.label}</option>)}
                  </select>
                  <small>{inferencePreset.description}</small>
                </label>}
                {operationalFields.map((field) => {
                  const value = configuration[field.name];
                  if (field.type === "checkbox") {
                    return (
                      <label className="configuration-toggle" key={field.name}>
                        <input
                          type="checkbox"
                          checked={value === true}
                          onChange={(event) =>
                            setConfiguration((current) => ({
                              ...current,
                              [field.name]: event.target.checked,
                            }))
                          }
                        />
                        <span><strong>{field.label}</strong><small>{field.help}</small></span>
                      </label>
                    );
                  }

                  if (field.type === "select") {
                    return (
                      <label key={field.name}>
                        {field.label}
                        <select
                          value={typeof value === "string" ? value : ""}
                          onChange={(event) => setConfiguration((current) => ({
                            ...current,
                            [field.name]: event.target.value,
                          }))}
                        >
                          {field.options?.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        <small>{field.help}</small>
                      </label>
                    );
                  }

                  return (
                    <label key={field.name}>
                      {field.label}
                      <input
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
                          setConfiguration((current) => {
                            const next: Record<string, string | number | boolean | string[] | undefined> = {
                              ...current,
                            };
                            if (nextValue.length === 0) {
                              delete next[field.name];
                            } else {
                              next[field.name] = field.type === "number"
                                ? Number(nextValue)
                                : field.type === "text-list"
                                  ? [...new Set(nextValue.split(",").map((item) => item.trim()).filter(Boolean))]
                                  : nextValue;
                            }
                            return next as ServiceConnectionConfiguration;
                          });
                        }}
                      />
                      <small>{field.help}</small>
                    </label>
                  );
                })}
              </div>
            </div>}

            {selectedKind !== "INFERENCE" && <div className="secret-section">
              <div><strong>Credentials</strong><span>Write-only encrypted values</span></div>
              {definition.secretFields.map((field) => {
                const stored = existing?.secretFieldNames.includes(field.name) ?? false;
                return (
                  <label key={field.name}>
                    {field.label}{stored && <small>Stored - leave blank to keep</small>}
                    <input
                      type="password"
                      value={secrets[field.name] ?? ""}
                      onChange={(event) => setSecrets((current) => ({ ...current, [field.name]: event.target.value }))}
                      required={!existing && field.required}
                      autoComplete="new-password"
                      placeholder={stored ? "••••••••••••" : "Enter credential"}
                    />
                  </label>
                );
              })}
            </div>}

            {existing && (selectedKind !== "INFERENCE" || inferenceAdvancedOpen) && (
              <section className="revision-section" aria-labelledby="revision-history-title">
                <div className="revision-heading">
                  <div>
                    <strong id="revision-history-title">Configuration history</strong>
                    <span>Credentials are never restored from an older revision.</span>
                  </div>
                  <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => void props.onLoadRevisions(existing.id)}
                  >
                    {props.revisionConnectionId === existing.id ? "Refresh history" : "View history"}
                  </button>
                </div>
                {props.revisionConnectionId === existing.id && props.revisionHistory && (
                  <div className="revision-list">
                    {props.revisionHistory.items.map((revision) => (
                      <article key={revision.id}>
                        <div>
                          <strong>{revision.displayName} · revision {revision.revision}</strong>
                          <span>
                            {revision.active
                              ? "Active configuration"
                              : `${revision.environment.toLowerCase()} · ${revision.enabled ? "enabled" : "disabled"} · ${new Date(revision.createdAt).toLocaleString()}`}
                          </span>
                          <span>{revision.baseUrl ?? "No endpoint configured"}</span>
                        </div>
                        {revision.active ? (
                          <span className="revision-active">Active</span>
                        ) : rollbackCandidate === revision.revision ? (
                          <div className="rollback-confirmation">
                            <span>Restore settings from this revision while keeping current credentials?</span>
                            <div>
                              <button type="button" onClick={() => setRollbackCandidate(null)}>Cancel</button>
                              <button
                                type="button"
                                disabled={props.busy}
                                onClick={() => {
                                  setRollbackCandidate(null);
                                  void props.onRollback(
                                    existing.id,
                                    revision.revision,
                                    props.revisionHistory!.activeRevision,
                                  );
                                }}
                              >Confirm restore</button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={props.busy}
                            onClick={() => setRollbackCandidate(revision.revision)}
                          >Restore</button>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {props.error && <p className="form-error">{props.error}</p>}
            <div className="drawer-actions">
              <Button type="button" onClick={props.onClose}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={props.busy}>{props.busy
                ? selectedKind === "INFERENCE" && enabled ? "Saving and verifying…" : "Saving…"
                : selectedKind === "INFERENCE" && inferenceDiscovery?.status === "READY"
                  ? "Activate AI Inference"
                  : existing ? "Save changes" : "Create connection"}</Button>
            </div>
          </form>
        )}
      </div>
    </Drawer>
  );
}
