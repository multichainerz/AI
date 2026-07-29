import type {
  CreateServiceConnection,
  ConnectionTestResult,
  ConfigurationRevisionList,
  Environment,
  ServiceConnectionConfiguration,
  ServiceConnectionSummary,
  ServiceKind,
} from "@aihub/contracts";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { connectionDefinitions } from "./connection-definitions.js";

export interface ConnectionDraft extends CreateServiceConnection {
  existingId?: string;
}

interface ConnectionDrawerProps {
  bootstrapState: "REQUIRED" | "READY" | "LOCKED";
  busy: boolean;
  connections: ServiceConnectionSummary[];
  error: string | null;
  diagnostic: ConnectionTestResult | null;
  initialKind: ServiceKind;
  open: boolean;
  unlocked: boolean;
  revisionConnectionId: string | null;
  revisionHistory: ConfigurationRevisionList | null;
  onClose: () => void;
  onSave: (draft: ConnectionDraft) => Promise<void>;
  onTest: (id: string) => Promise<void>;
  onUnlock: (token: string) => Promise<boolean>;
  onLoadRevisions: (connectionId: string) => Promise<void>;
  onRollback: (
    connectionId: string,
    targetRevision: number,
    expectedActiveRevision: number,
  ) => Promise<void>;
  onSignOut: () => Promise<void>;
}

function slugFor(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
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
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogPanel = useRef<HTMLElement>(null);
  const [token, setToken] = useState("");
  const [selectedKind, setSelectedKind] = useState<ServiceKind>(props.initialKind);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [environment, setEnvironment] = useState<Environment>("PRODUCTION");
  const [enabled, setEnabled] = useState(false);
  const [configuration, setConfiguration] = useState<ServiceConnectionConfiguration>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [rollbackCandidate, setRollbackCandidate] = useState<number | null>(null);

  const definition = useMemo(
    () => connectionDefinitions.find(({ kind }) => kind === selectedKind) ?? connectionDefinitions[0]!,
    [selectedKind],
  );
  const existing = props.connections.find(({ kind }) => kind === selectedKind);
  const diagnostic =
    existing && props.diagnostic?.connectionId === existing.id ? props.diagnostic : null;

  useEffect(() => setSelectedKind(props.initialKind), [props.initialKind]);

  useEffect(() => {
    if (!props.open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
      if (event.key === "Tab" && dialogPanel.current) {
        const focusable = Array.from(
          dialogPanel.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => closeButton.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [props.open]);

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
    setRollbackCandidate(null);
  }, [definition, existing]);

  if (!props.open) return null;

  const submitUnlock = async (event: FormEvent) => {
    event.preventDefault();
    if (await props.onUnlock(token)) setToken("");
  };

  const submitConnection = (event: FormEvent) => {
    event.preventDefault();
    const suppliedSecrets = Object.fromEntries(
      Object.entries(secrets).filter(([, value]) => value.trim().length > 0),
    );
    void props.onSave({
      ...(existing ? { existingId: existing.id } : {}),
      slug: slugFor(slug),
      displayName,
      kind: selectedKind,
      environment,
      baseUrl: baseUrl.trim() || null,
      enabled,
      configuration,
      secrets: suppliedSecrets,
    });
  };

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) props.onClose();
    }}>
      <aside ref={dialogPanel} className="connection-drawer" role="dialog" aria-modal="true" aria-labelledby="connection-drawer-title">
        <header>
          <div><p className="page-kicker">Secure configuration</p><h2 id="connection-drawer-title">Platform connections</h2></div>
          <div className="drawer-header-actions">
            {props.unlocked && <button type="button" onClick={() => void props.onSignOut()}>Sign out</button>}
            <button ref={closeButton} className="drawer-close" type="button" onClick={props.onClose} aria-label="Close settings">×</button>
          </div>
        </header>

        {!props.unlocked ? (
          <form className="unlock-form" onSubmit={submitUnlock}>
            <div className="lock-mark" aria-hidden="true">M</div>
            <h3>Unlock administrator setup</h3>
            <p>The setup token is checked by the AIHub backend and is never stored by this browser.</p>
            {props.bootstrapState !== "READY" && (
              <div className="form-notice">Bootstrap files are {props.bootstrapState.toLowerCase()}. Complete the server setup first.</div>
            )}
            <label>
              Bootstrap administrator token
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                required
                minLength={32}
                placeholder="Enter token"
              />
            </label>
            {props.error && <p className="form-error">{props.error}</p>}
            <button className="primary-button drawer-submit" type="submit" disabled={props.busy || props.bootstrapState !== "READY"}>
              {props.busy ? "Checking…" : "Unlock settings"}
            </button>
          </form>
        ) : (
          <form className="connection-form" onSubmit={submitConnection}>
            <div className="kind-tabs" role="tablist" aria-label="Connection type">
              {connectionDefinitions.map((item) => (
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
              <div className={`diagnostic-result ${diagnostic?.status.toLowerCase() ?? "idle"}`}>
                <div>
                  <strong>{diagnostic ? diagnostic.status : "Connection not tested in this session"}</strong>
                  <span>{diagnostic?.message ?? existing.lastHealthcheckMessage ?? "Run a credential-aware health check."}</span>
                </div>
                {diagnostic && <small>{diagnostic.latencyMs} ms</small>}
                <button type="button" disabled={props.busy} onClick={() => void props.onTest(existing.id)}>
                  {props.busy ? "Testing…" : "Test connection"}
                </button>
              </div>
            )}

            <div className="form-grid">
              <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength={2}/></label>
              <label>Slug<input value={slug} onChange={(event) => setSlug(slugFor(event.target.value))} required disabled={Boolean(existing)}/></label>
              <label className="wide">{definition.endpointLabel ?? "Endpoint URL"}<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selectedKind === "OIDC" ? "https://identity.mpm.internal" : "https://service.mpm.internal"}/></label>
              <label>Environment<select value={environment} onChange={(event) => setEnvironment(event.target.value as Environment)}><option value="DEVELOPMENT">Development</option><option value="STAGING">Staging</option><option value="PRODUCTION">Production</option></select></label>
              <label className="switch-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span>Enable after saving</span></label>
            </div>

            <div className="configuration-section">
              <div><strong>Operational settings</strong><span>Validated non-secret values</span></div>
              <div className="configuration-grid">
                {definition.configurationFields.map((field) => {
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
            </div>

            <div className="secret-section">
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
            </div>

            {existing && (
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
              <button type="button" onClick={props.onClose}>Cancel</button>
              <button className="primary-button" type="submit" disabled={props.busy}>{props.busy ? "Saving…" : existing ? "Save new revision" : "Create connection"}</button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
