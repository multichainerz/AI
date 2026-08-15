import type { AdministratorSession } from "@orcasynapse/contracts";
import { adminAccess } from "./admin-access.js";
import { PlatformUpdatePanel } from "./platform-update-panel.js";
import { Button, LockedScreen, PageHeader, Panel } from "./ui/index.js";

interface ApplicationViewProps {
  session: AdministratorSession | null;
  currentVersion: string;
  onConfigure: () => void;
  onOpenOperations: () => void;
}

/**
 * Settings → Application: the installation's own lifecycle.
 *
 * The update check used to sit in the middle of Setup, between "enroll the
 * agent runtime" and "record activation", where it had no ordering relation to
 * either — you do not update an installation as a step toward finishing one.
 * It is maintenance that outlives bring-up, so it gets the tab the
 * documentation had already been sending people to.
 */
export function ApplicationView({ session, currentVersion, onConfigure, onOpenOperations }: ApplicationViewProps) {
  const { unlocked } = adminAccess(session);

  if (!unlocked) {
    return <LockedScreen
      kicker="Application settings"
      title="Application"
      mark="A"
      reason="Sign in as an administrator to check for releases and read this installation's version."
      actionLabel="Open platform settings"
      onAction={onConfigure}
    />;
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        kicker="Application settings"
        title="This installation"
        description="Version, releases, and the update command VM1 runs. Nothing here changes how the workspace is configured."
      />

      <PlatformUpdatePanel currentVersion={currentVersion} />

      <Panel className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-[280px] flex-1">
          <strong className="block text-label font-semibold text-text">Updates are applied on VM1, not from the browser.</strong>
          <span className="mt-1 block text-body text-muted">
            OrcaSynapse reads the official release tags and hands back a pinned command. The installer's own upgrade
            safeguards stay in force, and this container is never given control of its host.
          </span>
        </div>
        <Button variant="ghost" className="shrink-0" onClick={onOpenOperations}>Open Operations</Button>
      </Panel>
    </div>
  );
}
