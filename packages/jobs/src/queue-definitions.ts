import { JOB_QUEUE_NAMES, type JobQueueName } from "@aihub/contracts";
import type { Queue } from "pg-boss";

export interface AIHubQueueDefinition {
  name: JobQueueName;
  displayName: string;
  options: Omit<Queue, "name">;
  workerEnabled: boolean;
}

const deadLetterQueue: AIHubQueueDefinition = {
  name: "aihub.dead-letter",
  displayName: "Dead letter",
  options: {
    policy: "standard",
    retentionSeconds: 60 * 60 * 24 * 30,
    deleteAfterSeconds: 0,
    warningQueueSize: 1,
  },
  workerEnabled: false,
};

export const AIHUB_QUEUE_DEFINITIONS: readonly AIHubQueueDefinition[] = [
  deadLetterQueue,
  {
    name: "aihub.system.probe",
    displayName: "System probe",
    options: {
      policy: "standard",
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: true,
      expireInSeconds: 60,
      heartbeatSeconds: 30,
      deleteAfterSeconds: 60 * 60 * 24,
      deadLetter: deadLetterQueue.name,
      warningQueueSize: 20,
      notify: true,
    },
    workerEnabled: true,
  },
  {
    name: "aihub.documents.convert",
    displayName: "Document conversion",
    options: {
      policy: "standard",
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      heartbeatSeconds: 60,
      deadLetter: deadLetterQueue.name,
      warningQueueSize: 100,
      notify: true,
    },
    workerEnabled: true,
  },
  {
    name: "aihub.documents.ocr",
    displayName: "Document OCR",
    options: {
      policy: "standard",
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 60 * 60,
      heartbeatSeconds: 60,
      deadLetter: deadLetterQueue.name,
      warningQueueSize: 100,
      notify: true,
    },
    workerEnabled: true,
  },
  {
    name: "aihub.memory.index",
    displayName: "Memory indexing",
    options: {
      policy: "standard",
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      heartbeatSeconds: 60,
      deadLetter: deadLetterQueue.name,
      warningQueueSize: 100,
      notify: true,
    },
    workerEnabled: true,
  },
  {
    name: "aihub.agents.run",
    displayName: "Hermes agent runs",
    options: {
      policy: "standard",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 65 * 60,
      heartbeatSeconds: 30,
      deadLetter: deadLetterQueue.name,
      warningQueueSize: 50,
      notify: true,
    },
    workerEnabled: true,
  },
];

const definedNames = new Set(AIHUB_QUEUE_DEFINITIONS.map(({ name }) => name));
if (definedNames.size !== JOB_QUEUE_NAMES.length) {
  throw new Error("AIHub job queue definitions must cover every contracted queue exactly once.");
}

export function queueDefinition(name: JobQueueName): AIHubQueueDefinition {
  const definition = AIHUB_QUEUE_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Queue '${name}' is not defined.`);
  return definition;
}
