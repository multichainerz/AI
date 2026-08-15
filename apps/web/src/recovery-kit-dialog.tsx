import type { OnboardingSnapshot } from "@orcasynapse/contracts";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  exportCredentialRecoveryKit,
  getOnboardingSnapshot,
  verifyCredentialRecoveryKit,
} from "./api.js";
import { Button, Dialog, Field, Input, MicroLabel, StatusText } from "./ui/index.js";

/**
 * Offline recovery for the connector encryption key.
 *
 * Lifted out of Setup rather than kept in it: this is not a bring-up step, and
 * it is the one action on that screen needing `readiness:approve` rather than
 * `readiness:manage` — what `/onboarding/recovery/export` returns is the
 * platform master key wrapped under a passphrase the caller chooses, so anyone
 * who can call it and can also read the secret table holds every stored
 * connection secret.
 *
 * The two forms it holds are separate transactions and are now modelled as
 * such. Sharing one passphrase field between "the secret I am choosing for a
 * kit I am creating" and "the secret that already protects a kit I am checking"
 * is not a tidy-up: it means typing a new export passphrase silently rewrote
 * the verification field beneath it, and vice versa.
 */
function downloadRecoveryKit(fileName: string, serializedKit: string): void {
  const url = URL.createObjectURL(new Blob([serializedKit], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function RecoveryKitDialog({
  open,
  snapshot,
  onClose,
  onSnapshot,
  onSessionExpired,
}: {
  open: boolean;
  snapshot: OnboardingSnapshot | null;
  onClose: () => void;
  /** A verified or re-exported kit changes the recovery record; hand it back up. */
  onSnapshot: (snapshot: OnboardingSnapshot) => void;
  onSessionExpired: () => void;
}) {
  const [recoveryOwner, setRecoveryOwner] = useState("");
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [exportedFileName, setExportedFileName] = useState("");
  const [verifyPassphrase, setVerifyPassphrase] = useState("");
  const [selectedKit, setSelectedKit] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Seeded on the recovery record's revision, not on the snapshot object.
   *
   * App re-renders on its own poll and the view reloads the snapshot behind
   * this dialog; keying on identity wrote the stored owner back over a name
   * being typed. The revision is what actually changes when the record does.
   */
  useEffect(() => {
    setRecoveryOwner(snapshot?.recovery.recoveryOwner ?? "");
  }, [snapshot?.recovery.revision]);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
      setError(cause instanceof Error ? cause.message : "The recovery kit operation could not be completed.");
    } finally {
      setBusy(null);
    }
  };

  const exportKit = async (event: FormEvent) => {
    event.preventDefault();
    if (!snapshot || exportPassphrase !== exportConfirm) return;
    await run("export", async () => {
      const exported = await exportCredentialRecoveryKit({
        recoveryOwner: recoveryOwner.trim(),
        passphrase: exportPassphrase,
        expectedRevision: snapshot.recovery.revision,
      });
      downloadRecoveryKit(exported.fileName, exported.serializedKit);
      /*
       * The exported name is reported on its own line and does not touch the
       * file picker below.
       *
       * It used to be written into the picker's label while the kit itself was
       * cleared, so the control read "orcasynapse-recovery-….json" — the
       * universal sign that a file is selected — above a Verify button that was
       * disabled precisely because none was. The operator's only way out was to
       * guess that the label was lying.
       */
      setExportedFileName(exported.fileName);
      setExportPassphrase("");
      setExportConfirm("");
      onSnapshot(await getOnboardingSnapshot());
    });
  };

  const verifyKit = async () => {
    if (!snapshot) return;
    await run("verify", async () => {
      onSnapshot(await verifyCredentialRecoveryKit({
        serializedKit: selectedKit,
        passphrase: verifyPassphrase,
        expectedRevision: snapshot.recovery.revision,
      }));
      setVerifyPassphrase("");
      setSelectedKit("");
      setSelectedFileName("");
      onClose();
    });
  };

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 16_384) {
      setError("Recovery kit exceeds the supported size.");
      return;
    }
    setSelectedFileName(file.name);
    setSelectedKit(await file.text());
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      kicker="Offline recovery"
      title="Protect connector encryption"
      description="Export an encrypted recovery kit and store it outside the OrcaSynapse host. The passphrase and kit are never retained by the dashboard."
    >
      {!snapshot
        ? <p className="m-0 text-body text-faint">Loading recovery state…</p>
        : <div className="grid gap-4">
          {error && <StatusText tone="bad" className="normal-case" role="alert">{error}</StatusText>}
          <form className="grid gap-3" onSubmit={(event) => void exportKit(event)}>
            <Field label="Recovery owner">
              <Input value={recoveryOwner} minLength={2} maxLength={160} placeholder="Infrastructure recovery team" onChange={(event) => setRecoveryOwner(event.target.value)} />
            </Field>
            <Field label="Recovery passphrase">
              <Input type="password" autoComplete="new-password" value={exportPassphrase} minLength={16} maxLength={1024} onChange={(event) => setExportPassphrase(event.target.value)} />
            </Field>
            <Field label="Confirm passphrase">
              <Input type="password" autoComplete="new-password" value={exportConfirm} minLength={16} maxLength={1024} onChange={(event) => setExportConfirm(event.target.value)} />
            </Field>
            {exportConfirm && exportPassphrase !== exportConfirm && (
              <StatusText tone="bad" className="normal-case">Passphrases do not match.</StatusText>
            )}
            <Button variant="primary" className="justify-self-end" disabled={busy !== null || recoveryOwner.trim().length < 2 || exportPassphrase.length < 16 || exportPassphrase !== exportConfirm} type="submit">
              {busy === "export" ? "Encrypting…" : "Export recovery kit"}
            </Button>
          </form>

          {exportedFileName && (
            <StatusText tone="good" className="normal-case">
              Saved as {exportedFileName}. Move it off this host, then verify the retained copy below.
            </StatusText>
          )}

          <div className="flex items-center gap-3 border-t border-border pt-4">
            <MicroLabel>Verify retained copy</MicroLabel>
          </div>
          <label className="grid cursor-pointer gap-1 rounded border border-dashed border-border-strong bg-raised px-4 py-4 text-center">
            <span className="text-body text-text">{selectedFileName || "Select the saved recovery kit"}</span>
            <Input className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void selectFile(event)} />
          </label>
          <Field label="Passphrase of the retained kit">
            <Input type="password" autoComplete="off" value={verifyPassphrase} minLength={16} maxLength={1024} onChange={(event) => setVerifyPassphrase(event.target.value)} />
          </Field>
          <Button className="justify-self-end" disabled={busy !== null || !selectedKit || verifyPassphrase.length < 16} onClick={() => void verifyKit()}>
            {busy === "verify" ? "Verifying…" : "Verify recovery kit"}
          </Button>
        </div>}
    </Dialog>
  );
}
