import type { AdministratorSession } from "@orcasynapse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConnectionDrawer } from "./connection-drawer.js";

const session: AdministratorSession = {
  id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
  subject: "local:admin",
  role: "PLATFORM_ADMIN",
  scopes: ["connections:read", "connections:write"],
  createdAt: new Date().toISOString(),
  idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  authenticationMethod: "LOCAL_PASSWORD",
  passwordChangeRequired: false,
};

describe("ConnectionDrawer inference endpoint", () => {
  it("renders a guided discovery flow and keeps manual fields behind an advanced control", () => {
    const html = renderToStaticMarkup(<ConnectionDrawer
      bootstrapState="READY"
      busy={false}
      connections={[]}
      monitoring={null}
      error={null}
      diagnostic={null}
      initialKind="INFERENCE"
      open
      session={session}
      revisionConnectionId={null}
      revisionHistory={null}
      onClose={vi.fn()}
      onSave={vi.fn(async () => undefined)}
      onTest={vi.fn(async () => undefined)}
      onDiscoverInference={vi.fn(async () => null)}
      onUpdateMonitoring={vi.fn(async () => undefined)}
      onLogin={vi.fn(async () => true)}
      onStartRecovery={vi.fn(async () => true)}
      onChangePassword={vi.fn(async () => true)}
      onRecover={vi.fn(async () => true)}
      onLoadRevisions={vi.fn(async () => undefined)}
      onRollback={vi.fn(async () => undefined)}
      onSignOut={vi.fn(async () => undefined)}
    />);

    expect(html).toContain("Connect and discover");
    expect(html).toContain("AI Inference address");
    expect(html).toContain("Discover server");
    expect(html).toContain("Advanced configuration");
    expect(html).not.toContain("Endpoint suggestion");
    expect(html).not.toContain("Serving implementation");
  });
});
