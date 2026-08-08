import type { AdministratorSession } from "@orcasynapse/contracts";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import { useState, type FormEvent } from "react";

/**
 * The pre-auth front page, from the OrcaNeuron design system: a violet hero
 * stating what the product is, and a white card that signs the operator in.
 * Nobody sees the workspace shell without a session any more — this page is
 * the whole signed-out surface, replacing the sign-in branch that used to
 * live inside the connection drawer.
 *
 * Deliberately theme-independent. The design draws this page in fixed light
 * regardless of the dashboard theme — an entrance, not a workspace — so its
 * colours are literals rather than tokens, the same way the sidebar's brand
 * panel is. Every colour is a class, never an inline style (`style-src 'self'`).
 *
 * The four states of the card are the four ways in: local sign-in, offline
 * recovery with the Installation Key, the forced password change a temporary
 * password lands in, and the recovery reset. Enterprise SSO is a redirect the
 * API owns, shown only when the deployment has OIDC configured.
 */

export type FrontPageMode = "LOGIN" | "RECOVERY";

interface FrontPageProps {
  bootstrapState: "REQUIRED" | "READY" | "LOCKED";
  busy: boolean;
  error: string | null;
  oidcConfigured: boolean;
  /** Present only when a session exists but must change its password first. */
  session: AdministratorSession | null;
  onLogin: (username: string, password: string) => Promise<boolean>;
  onStartRecovery: (installationKey: string) => Promise<boolean>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
  onRecover: (username: string, newPassword: string) => Promise<boolean>;
}

/**
 * The network diagram from the design: documents scanned on the left, the
 * OCR + retrieval orb in the middle, the local servers on the right, all
 * framed by the dashed "internal network" boundary. Pure SVG with keyframe
 * classes from styles.css, so `prefers-reduced-motion` stills the whole
 * drawing in one rule.
 */
function NetworkDiagram() {
  return (
    <svg viewBox="0 0 560 250" className="block w-full max-w-[560px] overflow-visible" aria-label="Ingestion and retrieval run inside your network">
      <rect x="14" y="16" width="532" height="218" rx="22" fill="none" stroke="#FFFFFF" strokeOpacity="0.28" strokeWidth="1.6" strokeDasharray="9 8" className="orb-dash" />
      <text x="34" y="42" fill="#B9A5FF" fontSize="10.5" fontWeight="600" letterSpacing="1.4" className="font-sans">INTERNAL NETWORK</text>

      <g className="orb-float">
        <rect x="44" y="86" width="66" height="84" rx="8" fill="#FFFFFF" fillOpacity="0.94" />
        <rect x="54" y="99" width="46" height="5" rx="2.5" fill="#6E5BC9" fillOpacity="0.55" />
        <rect x="54" y="112" width="34" height="5" rx="2.5" fill="#6E5BC9" fillOpacity="0.35" />
        <rect x="54" y="125" width="46" height="5" rx="2.5" fill="#6E5BC9" fillOpacity="0.35" />
        <rect x="54" y="138" width="28" height="5" rx="2.5" fill="#6E5BC9" fillOpacity="0.35" />
        <rect x="54" y="151" width="40" height="5" rx="2.5" fill="#6E5BC9" fillOpacity="0.2" />
        <rect x="44" y="86" width="66" height="84" rx="8" fill="none" stroke="#22D3EE" strokeOpacity="0.9" strokeWidth="2" />
        <rect x="44" y="86" width="66" height="10" rx="5" fill="#22D3EE" fillOpacity="0.5" className="orb-scan" />
      </g>

      <g stroke="#8C74F2" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round" fill="none">
        <path d="M118 128h74" />
        <path d="M300 128h58" />
      </g>
      <g fill="#22D3EE">
        <circle cx="128" cy="128" r="3.4" className="orb-travel" />
        <circle cx="308" cy="128" r="3.4" className="orb-travel orb-travel-late" />
      </g>

      <g>
        <circle cx="246" cy="128" r="54" fill="#7C5CF5" fillOpacity="0.14" className="orb-pulse" />
        <circle cx="246" cy="128" r="38" fill="#4A2BAE" fillOpacity="0.55" stroke="#B9A5FF" strokeOpacity="0.5" strokeWidth="1.6" />
        <g stroke="#C9BAFF" strokeOpacity="0.75" strokeWidth="1.8" strokeLinecap="round" fill="none">
          <path d="M246 110v-13M246 146v13M228 128h-14M264 128h14M233 115l-9-9M259 141l9 9M259 115l9-9M233 141l-9 9" />
        </g>
        <g fill="#B9A5FF">
          <circle cx="246" cy="97" r="4" /><circle cx="246" cy="159" r="4" />
          <circle cx="214" cy="128" r="4" /><circle cx="278" cy="128" r="4" />
        </g>
        <circle cx="246" cy="128" r="9" fill="#22D3EE" className="orb-core" />
        <g fill="none" stroke="#22D3EE" strokeOpacity="0.55" strokeWidth="1.4">
          <ellipse cx="246" cy="128" rx="62" ry="24" className="orb-spin" />
        </g>
        <text x="246" y="196" fill="#B9A5FF" textAnchor="middle" fontSize="10.5" fontWeight="600" letterSpacing="1.2" className="font-sans">OCR + RETRIEVAL</text>
      </g>

      <g>
        <rect x="366" y="70" width="132" height="118" rx="12" fill="#2A1470" stroke="#8C74F2" strokeOpacity="0.5" strokeWidth="1.6" />
        <rect x="380" y="84" width="104" height="28" rx="7" fill="#FFFFFF" fillOpacity="0.1" />
        <rect x="380" y="118" width="104" height="28" rx="7" fill="#FFFFFF" fillOpacity="0.1" />
        <rect x="380" y="152" width="104" height="22" rx="7" fill="#FFFFFF" fillOpacity="0.06" />
        <g fill="#22D3EE">
          <circle cx="394" cy="98" r="4" className="orb-blink" />
          <circle cx="394" cy="132" r="4" className="orb-blink orb-blink-late" />
          <circle cx="394" cy="163" r="3.4" className="orb-blink orb-blink-later" />
        </g>
        <g fill="#B9A5FF" fillOpacity="0.7">
          <rect x="410" y="95" width="52" height="5" rx="2.5" />
          <rect x="410" y="129" width="40" height="5" rx="2.5" />
          <rect x="410" y="159" width="46" height="5" rx="2.5" />
        </g>
        <text x="432" y="212" fill="#B9A5FF" textAnchor="middle" fontSize="10.5" fontWeight="600" letterSpacing="1.2" className="font-sans">YOUR SERVERS</text>
      </g>
    </svg>
  );
}

const FIELD =
  "flex items-center gap-2.5 rounded-input border border-black/[0.07] bg-[#F5F5FA] px-4 py-3 " +
  "focus-within:border-[#703DEF]/50";
const FIELD_INPUT =
  "min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] text-[#191A1C] outline-none placeholder:text-[#9A9BA4]";
const SUBMIT =
  "flex w-full items-center justify-between gap-3 rounded-input border-0 bg-[#703DEF] px-5 py-3.5 " +
  "text-[14.5px] font-semibold text-white transition-colors hover:bg-[#5B2EDB] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

function ArrowGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h15" /><path d="M13.5 6.5 19.5 12l-6 5.5" />
    </svg>
  );
}

export function FrontPage(props: FrontPageProps) {
  const [mode, setMode] = useState<FrontPageMode>("LOGIN");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [installationKey, setInstallationKey] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmedPassword, setConfirmedPassword] = useState("");

  const changeRequired = props.session?.passwordChangeRequired === true;
  const recovering = props.session?.authenticationMethod === "INSTALLATION_KEY_RECOVERY";

  const submitAccess = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "RECOVERY") {
      if (await props.onStartRecovery(installationKey)) setInstallationKey("");
      return;
    }
    if (await props.onLogin(username, password)) setPassword("");
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmedPassword) return;
    const completed = recovering
      ? await props.onRecover(username, newPassword)
      : await props.onChangePassword(currentPassword, newPassword);
    if (completed) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmedPassword("");
      setMode("LOGIN");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#EEF0FA] px-7 py-8">
      <div className="w-full max-w-[1280px] rounded-[26px] bg-white p-[22px] shadow-[0_30px_80px_-40px_rgba(46,16,101,0.35)]">
        <div className="relative overflow-hidden rounded-modal bg-brand px-6 pt-6 sm:px-9 sm:pt-7">

          <div className="flex flex-wrap items-center gap-3">
            <img src="/brand/sivali-mark.svg" alt="" width={30} height={30} className="block shrink-0" />
            <span className="font-display text-[18px] font-semibold tracking-[-0.01em] text-white">OrcaSynapse</span>
            <span className="flex-1" />
            <span className="text-caption text-white/60">On-prem AI control plane</span>
          </div>

          <div className="grid items-center gap-11 py-9 lg:grid-cols-[minmax(0,1fr)_396px] lg:pb-11">
            <div className="min-w-0">
              <h1 className="m-0 mt-3 max-w-[520px] font-display text-[34px] font-semibold leading-[1.14] tracking-[-0.035em] text-white sm:text-display">
                Your documents, models and memory stay inside your network.
              </h1>
              <p className="mb-0 mt-3.5 max-w-[470px] text-[15px] leading-[1.62] text-white/[0.68]">
                Ingestion, retrieval and governed inference run on servers you control. Not one
                byte reaches a third-party model provider.
              </p>
              <div className="mt-6 hidden sm:block">
                <NetworkDiagram />
              </div>
            </div>

            <div className="min-w-0 rounded-modal bg-white p-7 shadow-[0_24px_60px_-28px_rgba(20,8,60,0.55)] sm:p-8">
              {!changeRequired ? (
                <form onSubmit={submitAccess}>
                  <h2 className="m-0 font-display text-[26px] font-semibold tracking-[-0.028em] text-[#191A1C]">
                    {mode === "LOGIN" ? "Welcome back" : "Offline recovery"}
                  </h2>
                  <p className="mb-0 mt-1.5 text-[13px] text-[#6B6C74]">
                    {mode === "LOGIN"
                      ? "Sign in with the local administrator account."
                      : "Use the Installation Key from your vault only when the password cannot be recovered normally."}
                  </p>

                  {props.bootstrapState !== "READY" ? (
                    <p className="mb-0 mt-4 rounded-input border border-[#C77F62]/40 bg-[#C77F62]/10 px-3.5 py-2.5 text-[12px] text-[#A94E2C]">
                      Installation trust is {props.bootstrapState.toLowerCase()}. Complete the host installer first.
                    </p>
                  ) : null}

                  <div className="mt-6 flex flex-col gap-3">
                    {mode === "LOGIN" ? (
                      <>
                        <label className={FIELD}>
                          <input
                            className={FIELD_INPUT}
                            value={username}
                            onChange={(event) => setUsername(event.target.value)}
                            placeholder="Username"
                            aria-label="Username"
                            autoComplete="username"
                            required
                            maxLength={64}
                          />
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9A9BA4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                            <circle cx="12" cy="9" r="3.6" fill="currentColor" fillOpacity="0.14" />
                            <path d="M5.4 19.6a6.6 6.6 0 0 1 13.2 0" fill="currentColor" fillOpacity="0.14" />
                          </svg>
                        </label>
                        <label className={FIELD}>
                          <input
                            className={FIELD_INPUT}
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder="Password"
                            aria-label="Password"
                            autoComplete="current-password"
                            required
                            minLength={12}
                            maxLength={1024}
                          />
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9A9BA4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                            <rect x="4.8" y="10" width="14.4" height="10.2" rx="3" fill="currentColor" fillOpacity="0.14" />
                            <path d="M8 10V6.8a4 4 0 0 1 8 0V10" />
                          </svg>
                        </label>
                      </>
                    ) : (
                      <label className={FIELD}>
                        <input
                          className={FIELD_INPUT}
                          type="password"
                          value={installationKey}
                          onChange={(event) => setInstallationKey(event.target.value)}
                          placeholder="Installation Key"
                          aria-label="Installation Key"
                          autoComplete="off"
                          required
                          minLength={32}
                        />
                      </label>
                    )}
                  </div>

                  {props.error ? (
                    <p className="mb-0 mt-3.5 text-[12px] font-medium text-[#A94E2C]" role="alert">{props.error}</p>
                  ) : null}

                  <div className="mt-5 flex flex-wrap items-center gap-3.5">
                    <button className={SUBMIT} type="submit" disabled={props.busy || props.bootstrapState !== "READY"}>
                      <span>{props.busy ? "Verifying…" : mode === "LOGIN" ? "Sign in" : "Continue recovery"}</span>
                      <ArrowGlyph />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="mt-3.5 border-0 bg-transparent p-0 text-[12.5px] font-semibold text-[#6B6C74] hover:text-[#191A1C]"
                    onClick={() => setMode(mode === "LOGIN" ? "RECOVERY" : "LOGIN")}
                  >
                    {mode === "LOGIN" ? "Use offline recovery key" : "Return to local sign-in"}
                  </button>

                  {props.oidcConfigured ? (
                    <div className="mt-5 border-t border-black/[0.08] pt-4">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#9A9BA4]">Or continue with</div>
                      <button
                        type="button"
                        className="mt-2.5 rounded-pill border border-black/[0.12] bg-transparent px-4 py-2 text-[12.5px] font-semibold text-[#191A1C] transition-colors hover:border-[#703DEF] hover:text-[#703DEF]"
                        onClick={() => window.location.assign(`/api/v1/auth/oidc/start?returnTo=${encodeURIComponent("/#chat")}`)}
                      >
                        Enterprise SSO
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-5 flex items-start gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B6C74" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden="true">
                      <path d="M12 2.8 5 5.8v5.4c0 4.2 3 6.9 7 8.6 4-1.7 7-4.4 7-8.6V5.8z" fill="currentColor" fillOpacity="0.14" />
                      <path d="M8.8 11.8 11 14l4.2-4.4" stroke="#0E9BB5" strokeWidth="2.3" />
                    </svg>
                    <p className="m-0 text-[11.5px] leading-[1.5] text-[#6B6C74]">
                      Authentication stays inside your network. Sessions are HttpOnly and are never
                      stored by the browser.
                    </p>
                  </div>
                </form>
              ) : (
                <form onSubmit={submitPassword}>
                  <h2 className="m-0 font-display text-[26px] font-semibold tracking-[-0.028em] text-[#191A1C]">
                    {recovering ? "Reset local administrator" : "Change temporary password"}
                  </h2>
                  <p className="mb-0 mt-1.5 text-[13px] text-[#6B6C74]">
                    {recovering
                      ? "The recovery key has been verified. Set a new local password; every other local and recovery session will be revoked."
                      : "Set a permanent password before entering the workspace. Every other session for this account will be revoked."}
                  </p>

                  <div className="mt-6 flex flex-col gap-3">
                    {recovering ? (
                      <label className={FIELD}>
                        <input className={FIELD_INPUT} value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" aria-label="Username" autoComplete="username" required maxLength={64} />
                      </label>
                    ) : (
                      <label className={FIELD}>
                        <input className={FIELD_INPUT} type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Temporary password" aria-label="Temporary password" autoComplete="current-password" required minLength={12} maxLength={1024} />
                      </label>
                    )}
                    <label className={FIELD}>
                      <input className={FIELD_INPUT} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="New password" aria-label="New password" autoComplete="new-password" required minLength={12} maxLength={1024} />
                    </label>
                    <label className={FIELD}>
                      <input className={FIELD_INPUT} type="password" value={confirmedPassword} onChange={(event) => setConfirmedPassword(event.target.value)} placeholder="Confirm new password" aria-label="Confirm new password" autoComplete="new-password" required minLength={12} maxLength={1024} />
                    </label>
                  </div>

                  {confirmedPassword && newPassword !== confirmedPassword ? (
                    <p className="mb-0 mt-3.5 text-[12px] font-medium text-[#A94E2C]">The new passwords do not match.</p>
                  ) : null}
                  {props.error ? (
                    <p className="mb-0 mt-3.5 text-[12px] font-medium text-[#A94E2C]" role="alert">{props.error}</p>
                  ) : null}

                  <div className="mt-5">
                    <button className={SUBMIT} type="submit" disabled={props.busy || newPassword !== confirmedPassword}>
                      <span>{props.busy ? "Saving…" : recovering ? "Reset and sign in" : "Change password"}</span>
                      <ArrowGlyph />
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-5 border-t border-white/[0.12] py-4">
            <span className="text-[12px] text-white/[0.52]">OrcaSynapse · {ORCASYNAPSE_VERSION}</span>
            <span className="flex-1" />
            <span className="text-[12px] text-white/[0.62]">Private by architecture — no data leaves your deployment.</span>
          </div>

        </div>
      </div>
    </div>
  );
}
