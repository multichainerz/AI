import type { ChatArtifact, ChatArtifactList, HermesArtifactReceipt, HermesArtifactUpload } from "@orcasynapse/contracts";
import type { ChatPrincipal } from "../chat/chat-manager.js";
import type { NodeSignatureHeaders } from "../runtime-nodes/runtime-node-manager.js";

/**
 * Run artifacts: files an agent produced on VM2, published by the node-side
 * companion and retrieved by people. Ingest is the only node-facing surface;
 * everything a person reads goes through the division-scoped list and
 * download routes (phase 3).
 */
export interface ChatArtifactManager {
  ingest(nodeId: string, headers: NodeSignatureHeaders, input: HermesArtifactUpload): Promise<HermesArtifactReceipt>;
  /**
   * Division-bounded on the server, never the UI: an enterprise principal
   * sees exactly the rows whose stamped division matches their own -- null
   * matching null explicitly, the ScopedMemoryEntry rule -- and an
   * administrator preview sees every division, because operating the
   * deployment is what that session is for.
   */
  list(principal: ChatPrincipal, filter?: { conversationId?: string }): Promise<ChatArtifactList>;
  /**
   * The artifact and its bytes, under the same visibility rule as `list`.
   * A cross-division id resolves to NOT FOUND, not FORBIDDEN, so another
   * division's files cannot be confirmed to exist by probing ids.
   */
  download(principal: ChatPrincipal, artifactId: string): Promise<{ artifact: ChatArtifact; bytes: Buffer }>;
}

export class ArtifactNotFoundError extends Error {
  constructor(message = "The requested artifact does not exist.") {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

/** The artifact exists but its bytes live only on the node (`storage: NODE`). */
export class ArtifactNotRetainedError extends Error {
  constructor(message = "This artifact is larger than the retention limit and remains on its runtime node.") {
    super(message);
    this.name = "ArtifactNotRetainedError";
  }
}

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}
