import type { AIHubPrismaClient } from "@aihub/database";
import type { JobQueueName } from "@aihub/contracts";

export interface WorkerIdentity {
  id: string;
  name: string;
  version: string;
  queues: JobQueueName[];
}

export interface WorkerRegistry {
  markStarted(identity: WorkerIdentity): Promise<void>;
  markAlive(id: string): Promise<void>;
  markStopped(id: string): Promise<void>;
}

export class PrismaWorkerRegistry implements WorkerRegistry {
  constructor(private readonly prisma: AIHubPrismaClient) {}

  async markStarted(identity: WorkerIdentity): Promise<void> {
    const now = new Date();
    await this.prisma.workerNode.upsert({
      where: { id: identity.id },
      create: {
        id: identity.id,
        name: identity.name,
        version: identity.version,
        status: "ONLINE",
        queues: identity.queues,
        metadata: {},
        startedAt: now,
        lastSeenAt: now,
      },
      update: {
        name: identity.name,
        version: identity.version,
        status: "ONLINE",
        queues: identity.queues,
        startedAt: now,
        lastSeenAt: now,
        stoppedAt: null,
      },
    });
  }

  async markAlive(id: string): Promise<void> {
    await this.prisma.workerNode.update({
      where: { id },
      data: { status: "ONLINE", lastSeenAt: new Date(), stoppedAt: null },
    });
  }

  async markStopped(id: string): Promise<void> {
    const now = new Date();
    await this.prisma.workerNode.updateMany({
      where: { id },
      data: { status: "STOPPED", lastSeenAt: now, stoppedAt: now },
    });
  }
}
