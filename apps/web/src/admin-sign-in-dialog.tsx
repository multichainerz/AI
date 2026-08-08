import { useState, type FormEvent } from "react";
import { Alert, Button, Dialog, Field, Input } from "./ui/index.js";

/**
 * Administrator elevation for someone already inside the shell.
 *
 * The signed-out world is the front page now, so the only person who meets a
 * locked screen is an enterprise employee whose session opens Chat but not the
 * governed areas. Sending them back through the front page would sign them
 * out; this dialog raises an administrator session beside the one they keep.
 * It is the surviving descendant of the sign-in form that lived in the
 * connection drawer.
 */
export function AdminSignInDialog(props: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onLogin: (username: string, password: string) => Promise<boolean>;
  onStartRecovery: (installationKey: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"LOGIN" | "RECOVERY">("LOGIN");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [installationKey, setInstallationKey] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "RECOVERY") {
      if (await props.onStartRecovery(installationKey)) {
        setInstallationKey("");
        props.onClose();
      }
      return;
    }
    if (await props.onLogin(username, password)) {
      setPassword("");
      props.onClose();
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      kicker="Administration"
      title="Sign in as administrator"
      description="Your workspace session stays active. Administrator credentials establish a separate protected session for the governed areas."
    >
      <form className="grid gap-4" onSubmit={submit}>
        {mode === "LOGIN" ? (
          <>
            <Field label="Username">
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
                maxLength={64}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                minLength={12}
                maxLength={1024}
              />
            </Field>
          </>
        ) : (
          <Field label="Offline Installation Key" hint="Only when the local administrator password cannot be recovered normally.">
            <Input
              type="password"
              value={installationKey}
              onChange={(event) => setInstallationKey(event.target.value)}
              autoComplete="off"
              required
              minLength={32}
            />
          </Field>
        )}
        {props.error ? <Alert>{props.error}</Alert> : null}
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" type="button" onClick={() => setMode(mode === "LOGIN" ? "RECOVERY" : "LOGIN")}>
            {mode === "LOGIN" ? "Use offline recovery key" : "Return to local sign-in"}
          </Button>
          <Button variant="primary" type="submit" disabled={props.busy}>
            {props.busy ? "Verifying…" : mode === "LOGIN" ? "Sign in" : "Continue recovery"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
