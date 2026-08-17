import type { AdministratorSession } from "@orcasynapse/contracts";
import { Server } from "lucide-react";
import { adminAccess } from "./admin-access.js";
import { PlatformUpdatePanel } from "./platform-update-panel.js";
import { LockedScreen, WorkspaceIntro } from "./ui/index.js";

interface ApplicationViewProps {
  session: AdministratorSession | null;
  currentVersion: string;
  onConfigure: () => void;
}

/**
 * Settings → System: the installation's own lifecycle.
 *
 * The update check used to sit in the middle of Setup, between "enroll the
 * agent runtime" and "record activation", where it had no ordering relation to
 * either — you do not update an installation as a step toward finishing one.
 * It is maintenance that outlives bring-up, so it gets the tab the
 * documentation had already been sending people to.
 *
 * The routing token is still `Application`; only what an operator reads changed.
 * See the note at the top of `workspace-navigation.tsx`.
 */
export function ApplicationView({ session, currentVersion, onConfigure }: ApplicationViewProps) {
  const { unlocked, can } = adminAccess(session);

  if (!unlocked) {
    return <LockedScreen
      kicker="System settings"
      title="System"
      mark="S"
      reason="Sign in as an administrator to check for releases and read this installation's version."
      actionLabel="Open platform settings"
      onAction={onConfigure}
    />;
  }

  return (
    <div className="workspace-stack application-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
      <WorkspaceIntro
        icon={<Server className="size-4" aria-hidden="true" />}
        title="System"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <PlatformUpdatePanel currentVersion={currentVersion} canApprove={can("readiness:approve")} />
      </div>
    </div>
  );
}
