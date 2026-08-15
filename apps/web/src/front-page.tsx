import type { AdministratorSession } from "@orcasynapse/contracts";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { ArrowRight, KeyRound as KeyIcon, LockKeyhole as LockIcon, LogIn as GatewayIcon, UserRound as IdentityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SynapseField } from "./dashboard-hero.js";
import { ThemeToggle } from "./ui/theme-toggle.js";

/**
 * The pre-auth front page: a shadcn-composed violet product hero
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
 * The deployment in one picture, and deliberately the real one: an operator's
 * intent reaches the control plane, which holds identity, policy, models and
 * the audit trail, and which dispatches a governed run to an isolated Hermes
 * runtime that owns its own sessions, memory and tools. Inference is an
 * approved route out; the dashed return is the evidence coming back.
 *
 * It replaced an abstract "intent → harness → tools" drawing carrying fourteen
 * labels around an orbit. The picture an operator needs before signing in is
 * the boundary they are about to run things inside, not a metaphor — so this
 * one names the two machines, keeps a single left-to-right reading order, and
 * spends its contrast on the one box that is this product.
 *
 * Static by design, like the synapse field behind it. Every colour is a
 * presentation attribute rather than an inline style (`style-src 'self'`).
 */
const CONTROL_PLANE_CAPABILITIES = [
  "Identity · Policy",
  "Models · Prompts",
  "Approved inference",
  "Audit · Evidence",
];
// Deliberately the words the Agents area now uses for the same four things —
// Runtime, Memory, Skills, Agent tools — so the diagram an operator reads
// before signing in names what they will find inside.
const RUNTIME_CAPABILITIES = ["Native sessions", "Memory · Skills", "Agent tools"];

function DiagramCard({
  x,
  title,
  subtitle,
  items,
  hero,
}: {
  x: number;
  title: string;
  subtitle: string;
  items: string[];
  hero?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y="58"
        width={hero ? 184 : 142}
        height="126"
        rx="17"
        fill={hero ? "#2A1470" : "#FFFFFF"}
        fillOpacity={hero ? undefined : "0.07"}
        stroke={hero ? "#22D3EE" : "#8C74F2"}
        strokeOpacity={hero ? "0.5" : "0.55"}
        strokeWidth={hero ? 1.6 : 1.5}
      />
      <text x={x + 20} y="86" fill="#FFFFFF" fontSize="11" fontWeight="700" letterSpacing="0.8" className="font-sans">{title}</text>
      <text x={x + 20} y="100" fill="#B9A5FF" fontSize="8.5" className="font-sans">{subtitle}</text>
      {items.map((label, index) => (
        <g key={label}>
          <circle cx={x + 22} cy={118.5 + index * 17} r="2.5" fill="#22D3EE" fillOpacity={hero ? "1" : "0.75"} />
          <text x={x + 33} y={122 + index * 17} fill="#D8CFFF" fontSize="9" className="font-sans">{label}</text>
        </g>
      ))}
    </g>
  );
}

function DeploymentDiagram() {
  return (
    <svg
      viewBox="0 0 560 224"
      className="block w-full max-w-[520px] overflow-visible"
      aria-label="An operator's intent enters the OrcaSynapse control plane, which holds identity, policy, models, the approved inference route and the audit trail, and dispatches governed runs to an isolated Hermes runtime that owns its own sessions, memory and tools — all inside infrastructure you control"
    >
      <defs>
        <marker id="front-page-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
          <path d="M0 0 6 3 0 6Z" fill="#22D3EE" fillOpacity="0.9" />
        </marker>
      </defs>

      <rect x="8" y="10" width="544" height="204" rx="20" fill="none" stroke="#FFFFFF" strokeOpacity="0.24" strokeWidth="1.5" strokeDasharray="9 8" />
      <text x="28" y="35" fill="#B9A5FF" fontSize="10" fontWeight="650" letterSpacing="1.5" className="font-sans">INFRASTRUCTURE YOU CONTROL</text>

      <g>
        <rect x="26" y="93" width="114" height="56" rx="14" fill="#FFFFFF" fillOpacity="0.09" stroke="#B9A5FF" strokeOpacity="0.4" strokeWidth="1.4" />
        <circle cx="48" cy="112" r="5.5" fill="none" stroke="#22D3EE" strokeWidth="1.6" />
        <path d="M39 131c1.8-6.5 5-9.5 9-9.5s7.2 3 9 9.5" fill="none" stroke="#22D3EE" strokeLinecap="round" strokeWidth="1.6" />
        <text x="66" y="116" fill="#FFFFFF" fontSize="9.5" fontWeight="650" letterSpacing="0.5" className="font-sans">OPERATOR</text>
        <text x="66" y="131" fill="#B9A5FF" fontSize="8" className="font-sans">Intent · event</text>
      </g>

      {/* Solid out, dashed back: the request and the evidence it returns. Both
          carried the word for it until the labels turned out to be wider than
          the 40px they had to sit in, overprinting the cards on either side. */}
      <g fill="none" stroke="#22D3EE" strokeLinecap="round" strokeOpacity="0.85" strokeWidth="1.6">
        <path d="M140 121h24" markerEnd="url(#front-page-arrow)" />
        <path d="M352 100h34" markerEnd="url(#front-page-arrow)" />
      </g>
      <path d="M392 142h-34" fill="none" stroke="#22D3EE" strokeDasharray="4 6" strokeLinecap="round" strokeOpacity="0.6" strokeWidth="1.4" markerEnd="url(#front-page-arrow)" />

      <DiagramCard hero x={168} title="CONTROL PLANE" subtitle="Governs every run" items={CONTROL_PLANE_CAPABILITIES} />
      <DiagramCard x={392} title="HERMES" subtitle="Isolated runtime" items={RUNTIME_CAPABILITIES} />
    </svg>
  );
}

const FIELD =
  "flex min-h-[50px] items-center gap-3 rounded-input border border-black/[0.09] bg-[#F7F7F5] px-3.5 py-3 " +
  "transition-[border-color,background-color,box-shadow] focus-within:border-[#703DEF]/55 focus-within:bg-white " +
  "focus-within:shadow-[0_0_0_4px_rgba(112,61,239,0.08)]";
const FIELD_INPUT =
  "min-w-0 flex-1 border-0 bg-transparent p-0 text-[14.5px] text-[#191A1C] outline-none focus-visible:outline-none placeholder:text-[#93949C]";
const SUBMIT =
  "flex min-h-[50px] w-full items-center justify-between gap-3 rounded-input border-0 bg-[#703DEF] px-5 py-3.5 " +
  "text-[14.5px] font-semibold text-white shadow-[0_12px_24px_-14px_rgba(112,61,239,0.8)] transition-colors hover:bg-[#5B2EDB] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

type CredentialFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  label: string;
  icon: ReactNode;
};

function CredentialField({ label, icon, ...input }: CredentialFieldProps) {
  return (
    <label className="group grid gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-[#6B6C74]">{label}</span>
      <span className={FIELD}>
        <span className="flex shrink-0 text-[#6B6C74] transition-colors group-focus-within:text-[#703DEF] [&_.fill-node]:fill-[#0E9BB5]">
          {icon}
        </span>
        <Input className={FIELD_INPUT} {...input} />
      </span>
    </label>
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
    <div className="front-page relative isolate flex min-h-screen items-center justify-center overflow-hidden px-5 py-3 sm:px-7">
      <SynapseField className="dashboard-synapse--front-page" />
      <div className="front-page__frame relative z-[1] w-full max-w-[1180px] rounded p-4">
        <div className="front-page__presentation relative overflow-hidden rounded-modal bg-brand px-6 pt-5 sm:px-8">

          <div className="relative z-[1] flex flex-wrap items-center gap-3">
            <img src="/brand/sivali-mark.svg" alt="" width={30} height={30} className="block shrink-0" />
            <span className="font-display text-[18px] font-semibold tracking-[-0.01em] text-white">OrcaSynapse</span>
            <span className="flex-1" />
            <ThemeToggle tone="brand" />
          </div>

          <div className="relative z-[1] grid items-center gap-8 py-6 lg:grid-cols-[minmax(0,1fr)_396px] lg:pb-7">
            <div className="min-w-0">
              <h1 className="m-0 max-w-[520px] font-display text-[34px] font-semibold leading-[1.14] tracking-[-0.035em] text-white sm:text-display">
                Dynamic intelligence, orchestrated into action.
              </h1>
              <p className="mb-0 mt-3.5 max-w-[470px] text-[15px] leading-[1.62] text-white/[0.68]">
                OrcaSynapse is the control plane for Hermes-native sessions, agent profiles, models,
                policy, and tools—all inside infrastructure you control.
              </p>
              <div className="mt-5 hidden sm:block">
                <DeploymentDiagram />
              </div>
            </div>

            <div
              className="min-w-0 overflow-hidden rounded border border-black/[0.12] bg-white shadow-[0_12px_30px_rgba(0,0,0,0.14)]"
              role="region"
              aria-label="Administrator access"
            >
              <div className="p-6 sm:p-7">
              {!changeRequired ? (
                <form onSubmit={submitAccess} aria-label={mode === "LOGIN" ? "Sign in" : "Offline recovery"}>
                  {props.bootstrapState !== "READY" ? (
                    <p className="mb-4 mt-0 rounded-input border border-[#A94E2C]/40 bg-[#A94E2C]/10 px-3.5 py-2.5 text-[12px] text-[#A94E2C]">
                      Installation trust is {props.bootstrapState.toLowerCase()}. Complete the host installer first.
                    </p>
                  ) : null}

                  <div className="flex flex-col gap-3">
                    {mode === "LOGIN" ? (
                      <>
                        <CredentialField
                          label="Username"
                          icon={<IdentityIcon size={18} />}
                          value={username}
                          onChange={(event) => setUsername(event.target.value)}
                          placeholder="Administrator username"
                          aria-label="Username"
                          autoComplete="username"
                          required
                          maxLength={64}
                        />
                        <CredentialField
                          label="Password"
                          icon={<LockIcon size={18} />}
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder="Enter your password"
                          aria-label="Password"
                          autoComplete="current-password"
                          required
                          minLength={12}
                          maxLength={1024}
                        />
                      </>
                    ) : (
                      <CredentialField
                        label="Installation Key"
                        icon={<KeyIcon size={18} />}
                        type="password"
                        value={installationKey}
                        onChange={(event) => setInstallationKey(event.target.value)}
                        placeholder="Paste your installation key"
                        aria-label="Installation Key"
                        autoComplete="off"
                        required
                        minLength={32}
                      />
                    )}
                  </div>

                  {props.error ? (
                    <p className="mb-0 mt-3.5 text-[12px] font-medium text-[#A94E2C]" role="alert">{props.error}</p>
                  ) : null}

                  <div className="mt-5 flex flex-wrap items-center gap-3.5">
                    <Button className={SUBMIT} type="submit" disabled={props.busy || props.bootstrapState !== "READY"}>
                      <span>{props.busy ? "Verifying…" : mode === "LOGIN" ? "Sign in" : "Continue recovery"}</span>
                      <ArrowRight aria-hidden="true" className="h-[17px] w-[17px]" />
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    className="mt-3.5 flex w-full items-center gap-2.5 rounded-input border border-black/[0.08] bg-transparent px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-[#6B6C74] transition-colors hover:border-[#703DEF]/35 hover:bg-[#703DEF]/[0.04] hover:text-[#191A1C]"
                    onClick={() => setMode(mode === "LOGIN" ? "RECOVERY" : "LOGIN")}
                  >
                    <span className="flex text-[#703DEF] [&_.fill-node]:fill-[#0E9BB5]">
                      {mode === "LOGIN" ? <KeyIcon size={17} /> : <IdentityIcon size={17} />}
                    </span>
                    <span className="flex-1">{mode === "LOGIN" ? "Use offline recovery key" : "Return to local sign-in"}</span>
                    <ArrowRight aria-hidden="true" className="h-[17px] w-[17px]" />
                  </Button>

                  {props.oidcConfigured ? (
                    <div className="mt-5 border-t border-black/[0.08] pt-4">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#93949C]">Or continue with</div>
                      <Button
                        variant="outline"
                        className="mt-2.5 flex w-full items-center gap-2.5 rounded-input border border-black/[0.12] bg-transparent px-3.5 py-2.5 text-[12.5px] font-semibold text-[#191A1C] transition-colors hover:border-[#703DEF] hover:text-[#703DEF]"
                        onClick={() => window.location.assign(`/api/v1/auth/oidc/start?returnTo=${encodeURIComponent("/#chat")}`)}
                      >
                        <GatewayIcon size={17} />
                        <span className="flex-1 text-left">Enterprise SSO</span>
                        <ArrowRight aria-hidden="true" className="h-[17px] w-[17px]" />
                      </Button>
                    </div>
                  ) : null}
                </form>
              ) : (
                <form
                  onSubmit={submitPassword}
                  aria-label={recovering ? "Reset local administrator" : "Change temporary password"}
                >
                  <div className="flex flex-col gap-3">
                    {recovering ? (
                      <CredentialField
                        label="Username"
                        icon={<IdentityIcon size={18} />}
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="Administrator username"
                        aria-label="Username"
                        autoComplete="username"
                        required
                        maxLength={64}
                      />
                    ) : (
                      <CredentialField
                        label="Temporary password"
                        icon={<KeyIcon size={18} />}
                        type="password"
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                        placeholder="Enter temporary password"
                        aria-label="Temporary password"
                        autoComplete="current-password"
                        required
                        minLength={12}
                        maxLength={1024}
                      />
                    )}
                    <CredentialField
                      label="New password"
                      icon={<LockIcon size={18} />}
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      placeholder="Create a permanent password"
                      aria-label="New password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={1024}
                    />
                    <CredentialField
                      label="Confirm new password"
                      icon={<LockIcon size={18} />}
                      type="password"
                      value={confirmedPassword}
                      onChange={(event) => setConfirmedPassword(event.target.value)}
                      placeholder="Repeat the permanent password"
                      aria-label="Confirm new password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={1024}
                    />
                  </div>

                  {confirmedPassword && newPassword !== confirmedPassword ? (
                    <p className="mb-0 mt-3.5 text-[12px] font-medium text-[#A94E2C]">The new passwords do not match.</p>
                  ) : null}
                  {props.error ? (
                    <p className="mb-0 mt-3.5 text-[12px] font-medium text-[#A94E2C]" role="alert">{props.error}</p>
                  ) : null}

                  <div className="mt-5">
                    <Button className={SUBMIT} type="submit" disabled={props.busy || newPassword !== confirmedPassword}>
                      <span>{props.busy ? "Saving…" : recovering ? "Reset and sign in" : "Change password"}</span>
                      <ArrowRight aria-hidden="true" className="h-[17px] w-[17px]" />
                    </Button>
                  </div>
                </form>
              )}
              </div>
            </div>
          </div>

          <div className="relative z-[1] flex flex-wrap items-center gap-5 border-t border-white/[0.12] py-4">
            <span className="text-[12px] text-white/[0.52]">OrcaSynapse · {ORCASYNAPSE_VERSION}</span>
          </div>

        </div>
      </div>
    </div>
  );
}
