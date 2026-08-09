import type { AdministratorSession } from "@orcasynapse/contracts";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import { useState, type FormEvent } from "react";
import { SynapseField } from "./dashboard-hero.js";
import { currentTheme, toggleTheme, type Theme } from "./theme.js";

/**
 * The pre-auth front page, from the OrcaNeuron design system: a violet hero
 * presenting the private agentic harness, and a white card that signs the
 * operator in.
 * Nobody sees the workspace shell without a session any more — this page is
 * the whole signed-out surface, replacing the sign-in branch that used to
 * live inside the connection drawer.
 *
 * The outer field follows the persisted dashboard theme; the violet product
 * panel and white authentication card stay fixed so their foreground contrast
 * never shifts underneath the operator. Every colour is a class, never an
 * inline style (`style-src 'self'`).
 *
 * Literal does not mean free-hand: each one on the white card is the *value*
 * of the matching light-theme token in `styles.css` (#F7F7F5 raised,
 * #191A1C text, #6B6C74 muted, #93949C faint, #703DEF accent,
 * #A94E2C bad, #0E9BB5 node). Five had drifted a few units off — a page that
 * is almost the light theme reads as a rendering fault rather than a design,
 * so when a value here changes, copy it from the light block rather than
 * eyeballing it. The violet hero is the exception: it is the brand panel, so
 * its palette is the brand one, cyan #22D3EE included.
 *
 * The four states of the card are the four ways in: local sign-in, offline
 * recovery with the Installation Key, the forced password change a temporary
 * password lands in, and the recovery reset. Enterprise SSO is a redirect the
 * API owns, shown only when the deployment has OIDC configured.
 */

type FrontPageMode = "LOGIN" | "RECOVERY";

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
 * The product in one picture: intent enters a governed agentic harness, which
 * coordinates models, knowledge, memory, policy, and tools before an action
 * leaves the controlled environment. The return path makes the operational
 * loop explicit without implying that a document pipeline is the product.
 * Static by design, like the synapse field behind it.
 */
function AgenticHarnessDiagram() {
  return (
    <svg
      viewBox="0 0 560 250"
      className="block w-full max-w-[520px] overflow-visible"
      aria-label="Agentic workflow coordinates intelligence and action inside your controlled environment"
    >
      <defs>
        <marker id="front-page-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
          <path d="M0 0 6 3 0 6Z" fill="#22D3EE" fillOpacity="0.9" />
        </marker>
      </defs>

      <rect x="14" y="16" width="532" height="218" rx="22" fill="none" stroke="#FFFFFF" strokeOpacity="0.28" strokeWidth="1.6" strokeDasharray="9 8" />
      <text x="34" y="42" fill="#B9A5FF" fontSize="10.5" fontWeight="600" letterSpacing="1.4" className="font-sans">CONTROLLED ENVIRONMENT</text>

      <g>
        <rect x="34" y="94" width="82" height="64" rx="12" fill="#FFFFFF" fillOpacity="0.1" stroke="#8C74F2" strokeOpacity="0.65" strokeWidth="1.5" />
        <circle cx="53" cy="116" r="6" fill="#22D3EE" fillOpacity="0.18" stroke="#22D3EE" strokeWidth="1.5" />
        <path d="m50 116 2 2 4-5" fill="none" stroke="#22D3EE" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        <text x="67" y="119" fill="#FFFFFF" fontSize="10.5" fontWeight="650" className="font-sans">INTENT</text>
        <text x="51" y="140" fill="#B9A5FF" fontSize="8.5" className="font-sans">Human · event</text>
      </g>

      <g fill="none" stroke="#8C74F2" strokeLinecap="round" strokeWidth="1.5">
        <path d="M116 126h62" markerEnd="url(#front-page-arrow)" />
        <path d="M326 126h56" markerEnd="url(#front-page-arrow)" />
        <path d="M222 82 207 68" strokeOpacity="0.68" />
        <path d="m276 82 29-14" strokeOpacity="0.68" />
        <path d="m219 164-17 15" strokeOpacity="0.68" />
        <path d="m278 163 20 16" strokeOpacity="0.68" />
      </g>

      <g>
        <circle cx="252" cy="126" r="66" fill="#7C5CF5" fillOpacity="0.08" stroke="#8C74F2" strokeOpacity="0.22" />
        <circle cx="252" cy="126" r="45" fill="#4A2BAE" fillOpacity="0.82" stroke="#B9A5FF" strokeOpacity="0.6" strokeWidth="1.6" />
        <path d="M232 125c8-14 18-18 29-10 7 5 8 15 2 24-6 8-18 8-26 1-7-6-10-16-5-25" fill="none" stroke="#22D3EE" strokeLinecap="round" strokeWidth="2" />
        <circle cx="232" cy="125" r="4" fill="#22D3EE" />
        <circle cx="263" cy="139" r="4" fill="#22D3EE" />
        <circle cx="261" cy="115" r="3" fill="#B9A5FF" />
        <text x="252" y="150" fill="#FFFFFF" textAnchor="middle" fontSize="8.5" fontWeight="650" letterSpacing="0.9" className="font-sans">PLAN · REASON</text>
      </g>

      {[
        [166, 49, 76, "MODELS"],
        [286, 49, 94, "KNOWLEDGE"],
        [160, 176, 84, "MEMORY"],
        [286, 176, 76, "POLICY"],
      ].map(([x, y, width, label]) => (
        <g key={String(label)}>
          <rect x={x} y={y} width={width} height="25" rx="12.5" fill="#FFFFFF" fillOpacity="0.09" stroke="#B9A5FF" strokeOpacity="0.36" />
          <circle cx={Number(x) + 13} cy={Number(y) + 12.5} r="2.8" fill="#22D3EE" />
          <text x={Number(x) + 23} y={Number(y) + 16} fill="#D8CFFF" fontSize="8.5" fontWeight="650" letterSpacing="0.7" className="font-sans">{label}</text>
        </g>
      ))}
      <text x="252" y="216" fill="#B9A5FF" textAnchor="middle" fontSize="10.5" fontWeight="650" letterSpacing="1.2" className="font-sans">AGENTIC HARNESS</text>

      <g>
        <rect x="389" y="77" width="130" height="96" rx="13" fill="#2A1470" stroke="#8C74F2" strokeOpacity="0.55" strokeWidth="1.5" />
        <text x="406" y="100" fill="#FFFFFF" fontSize="10.5" fontWeight="650" className="font-sans">TOOLS + ACTIONS</text>
        <g fill="#FFFFFF" fillOpacity="0.08">
          <rect x="404" y="111" width="100" height="15" rx="7.5" />
          <rect x="404" y="132" width="100" height="15" rx="7.5" />
        </g>
        <g fill="#22D3EE">
          <circle cx="415" cy="118.5" r="2.8" />
          <circle cx="415" cy="139.5" r="2.8" />
        </g>
        <text x="425" y="121.5" fill="#B9A5FF" fontSize="8" className="font-sans">Execute workflows</text>
        <text x="425" y="142.5" fill="#B9A5FF" fontSize="8" className="font-sans">Operate systems</text>
        <text x="454" y="162" fill="#22D3EE" textAnchor="middle" fontSize="8" fontWeight="650" letterSpacing="0.7" className="font-sans">GOVERNED OUTPUT</text>
      </g>

      <path d="M454 180C431 224 145 228 75 170" fill="none" stroke="#22D3EE" strokeDasharray="4 7" strokeOpacity="0.55" strokeWidth="1.4" markerEnd="url(#front-page-arrow)" />
      <text x="393" y="217" fill="#B9A5FF" fontSize="8" fontWeight="600" letterSpacing="0.7" className="font-sans">OBSERVE · ADAPT · CONTINUE</text>
    </svg>
  );
}

const FIELD =
  "flex items-center gap-2.5 rounded-input border border-black/[0.07] bg-[#F7F7F5] px-4 py-3 " +
  "focus-within:border-[#703DEF]/50";
const FIELD_INPUT =
  "min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] text-[#191A1C] outline-none placeholder:text-[#93949C]";
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
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
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
    <div className="front-page relative isolate flex min-h-screen items-center justify-center overflow-hidden px-5 py-3 sm:px-7">
      <SynapseField className="dashboard-synapse--front-page" />
      <div className="front-page__frame relative z-[1] w-full max-w-[1180px] rounded-[26px] p-4">
        <div className="front-page__presentation relative overflow-hidden rounded-modal bg-brand px-6 pt-5 sm:px-8">

          <div className="relative z-[1] flex flex-wrap items-center gap-3">
            <img src="/brand/sivali-mark.svg" alt="" width={30} height={30} className="block shrink-0" />
            <span className="font-display text-[18px] font-semibold tracking-[-0.01em] text-white">OrcaSynapse</span>
            <span className="flex-1" />
            <div className="flex items-center gap-3">
              <span className="hidden text-caption text-white/60 sm:inline">Private agentic intelligence</span>
              <button
                type="button"
                role="switch"
                aria-checked={theme === "light"}
                aria-label="Light appearance"
                title={`Switch to the ${theme === "light" ? "dark" : "light"} theme`}
                className="front-page-theme-toggle"
                onClick={() => setTheme(toggleTheme())}
              >
                <span className="front-page-theme-toggle__track" aria-hidden="true">
                  <span className="front-page-theme-toggle__thumb" />
                </span>
                <span>{theme === "light" ? "Light" : "Dark"}</span>
              </button>
            </div>
          </div>

          <div className="relative z-[1] grid items-center gap-8 py-6 lg:grid-cols-[minmax(0,1fr)_396px] lg:pb-7">
            <div className="min-w-0">
              <h1 className="m-0 max-w-[520px] font-display text-[34px] font-semibold leading-[1.14] tracking-[-0.035em] text-white sm:text-display">
                Dynamic intelligence, orchestrated into action.
              </h1>
              <p className="mb-0 mt-3.5 max-w-[470px] text-[15px] leading-[1.62] text-white/[0.68]">
                OrcaSynapse is the agentic harness that coordinates models, knowledge, memory,
                policy, and tools into adaptive workflows—all inside infrastructure you control.
              </p>
              <div className="mt-5 hidden sm:block">
                <AgenticHarnessDiagram />
              </div>
            </div>

            <div className="min-w-0 rounded-modal bg-white p-7 shadow-[0_24px_60px_-28px_rgba(20,8,60,0.55)] sm:p-8">
              {!changeRequired ? (
                <form onSubmit={submitAccess}>
                  <h2 className="m-0 font-display text-[26px] font-semibold tracking-[-0.028em] text-[#191A1C]">
                    {mode === "LOGIN" ? "Enter the control plane" : "Offline recovery"}
                  </h2>
                  <p className="mb-0 mt-1.5 text-[13px] text-[#6B6C74]">
                    {mode === "LOGIN"
                      ? "Sign in to operate and govern your intelligence workflows."
                      : "Use the Installation Key from your vault only when the password cannot be recovered normally."}
                  </p>

                  {props.bootstrapState !== "READY" ? (
                    <p className="mb-0 mt-4 rounded-input border border-[#A94E2C]/40 bg-[#A94E2C]/10 px-3.5 py-2.5 text-[12px] text-[#A94E2C]">
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
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#93949C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                            <circle cx="12" cy="9" r="3.6" fill="#93949C" fillOpacity="0.14" />
                            <path d="M5.4 19.6a6.6 6.6 0 0 1 13.2 0" fill="#93949C" fillOpacity="0.14" />
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
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#93949C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                            <rect x="4.8" y="10" width="14.4" height="10.2" rx="3" fill="#93949C" fillOpacity="0.14" />
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
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#93949C]">Or continue with</div>
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
                      <path d="M12 2.8 5 5.8v5.4c0 4.2 3 6.9 7 8.6 4-1.7 7-4.4 7-8.6V5.8z" fill="#6B6C74" fillOpacity="0.14" />
                      <path d="M8.8 11.8 11 14l4.2-4.4" stroke="#0E9BB5" strokeWidth="2.3" />
                    </svg>
                    <p className="m-0 text-[11.5px] leading-[1.5] text-[#6B6C74]">
                      Identity, policy, and execution stay within your controlled environment.
                      Sessions are HttpOnly and are never stored by the browser.
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

          <div className="relative z-[1] flex flex-wrap items-center gap-5 border-t border-white/[0.12] py-4">
            <span className="text-[12px] text-white/[0.52]">OrcaSynapse · {ORCASYNAPSE_VERSION}</span>
            <span className="flex-1" />
            <span className="text-[12px] text-white/[0.62]">Private intelligence. Governed execution. Your infrastructure.</span>
          </div>

        </div>
      </div>
    </div>
  );
}
