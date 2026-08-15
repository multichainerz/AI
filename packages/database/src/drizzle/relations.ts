import { relations } from "drizzle-orm/relations";
import { enterpriseUser, enterpriseUserSession, serviceConnection, secretRecord, configurationRevision, chatMessage, chatFeedback, agentProfile, agentProfileVersion, chatConversation, agentRun, agentToolGrant, governedTool, oidcAuthorizationRequest, governedToolCall, toolApproval, modelDeployment, agentRunEvent, hermesRuntimeNode, hermesNodeRequestNonce, hermesNodeEnrollment, hermesCorpusSnapshot, hermesCorpusEntry, hermesCorpusMutation, hermesCorpusRevision, agentRunApproval } from "./schema.js";

export const enterpriseUserSessionRelations = relations(enterpriseUserSession, ({one}) => ({
	enterpriseUser: one(enterpriseUser, {
		fields: [enterpriseUserSession.userId],
		references: [enterpriseUser.id]
	}),
}));

export const enterpriseUserRelations = relations(enterpriseUser, ({many}) => ({
	enterpriseUserSessions: many(enterpriseUserSession),
}));

export const secretRecordRelations = relations(secretRecord, ({one}) => ({
	serviceConnection: one(serviceConnection, {
		fields: [secretRecord.serviceConnectionId],
		references: [serviceConnection.id]
	}),
}));

export const serviceConnectionRelations = relations(serviceConnection, ({many}) => ({
	secretRecords: many(secretRecord),
	configurationRevisions: many(configurationRevision),
	oidcAuthorizationRequests: many(oidcAuthorizationRequest),
	modelDeployments: many(modelDeployment),
	hermesRuntimeNodes: many(hermesRuntimeNode),
}));

export const configurationRevisionRelations = relations(configurationRevision, ({one}) => ({
	serviceConnection: one(serviceConnection, {
		fields: [configurationRevision.serviceConnectionId],
		references: [serviceConnection.id]
	}),
}));

export const chatFeedbackRelations = relations(chatFeedback, ({one}) => ({
	chatMessage: one(chatMessage, {
		fields: [chatFeedback.messageId],
		references: [chatMessage.id]
	}),
}));

export const chatMessageRelations = relations(chatMessage, ({one, many}) => ({
	chatFeedbacks: many(chatFeedback),
	chatConversation: one(chatConversation, {
		fields: [chatMessage.conversationId],
		references: [chatConversation.id]
	}),
	agentRun: one(agentRun, {
		fields: [chatMessage.agentRunId],
		references: [agentRun.id]
	}),
}));

export const agentProfileVersionRelations = relations(agentProfileVersion, ({one, many}) => ({
	agentProfile: one(agentProfile, {
		fields: [agentProfileVersion.profileId],
		references: [agentProfile.id]
	}),
	agentToolGrants: many(agentToolGrant),
	agentRuns: many(agentRun),
}));

export const agentProfileRelations = relations(agentProfile, ({many}) => ({
	agentProfileVersions: many(agentProfileVersion),
	agentRuns: many(agentRun),
}));


export const chatConversationRelations = relations(chatConversation, ({many}) => ({
	chatMessages: many(chatMessage),
}));

export const agentRunRelations = relations(agentRun, ({one, many}) => ({
	chatMessages: many(chatMessage),
	governedToolCalls: many(governedToolCall),
	agentRunEvents: many(agentRunEvent),
	agentProfile: one(agentProfile, {
		fields: [agentRun.profileId],
		references: [agentProfile.id]
	}),
	agentProfileVersion: one(agentProfileVersion, {
		fields: [agentRun.profileVersionId],
		references: [agentProfileVersion.id]
	}),
	agentRunApprovals: many(agentRunApproval),
}));

export const agentToolGrantRelations = relations(agentToolGrant, ({one, many}) => ({
	agentProfileVersion: one(agentProfileVersion, {
		fields: [agentToolGrant.profileVersionId],
		references: [agentProfileVersion.id]
	}),
	governedTool: one(governedTool, {
		fields: [agentToolGrant.toolId],
		references: [governedTool.id]
	}),
	governedToolCalls: many(governedToolCall),
}));

export const governedToolRelations = relations(governedTool, ({many}) => ({
	agentToolGrants: many(agentToolGrant),
	governedToolCalls: many(governedToolCall),
}));

export const oidcAuthorizationRequestRelations = relations(oidcAuthorizationRequest, ({one}) => ({
	serviceConnection: one(serviceConnection, {
		fields: [oidcAuthorizationRequest.serviceConnectionId],
		references: [serviceConnection.id]
	}),
}));

export const governedToolCallRelations = relations(governedToolCall, ({one, many}) => ({
	agentRun: one(agentRun, {
		fields: [governedToolCall.runId],
		references: [agentRun.id]
	}),
	governedTool: one(governedTool, {
		fields: [governedToolCall.toolId],
		references: [governedTool.id]
	}),
	agentToolGrant: one(agentToolGrant, {
		fields: [governedToolCall.grantId],
		references: [agentToolGrant.id]
	}),
	toolApprovals: many(toolApproval),
}));

export const toolApprovalRelations = relations(toolApproval, ({one}) => ({
	governedToolCall: one(governedToolCall, {
		fields: [toolApproval.callId],
		references: [governedToolCall.id]
	}),
}));


export const modelDeploymentRelations = relations(modelDeployment, ({one}) => ({
	serviceConnection: one(serviceConnection, {
		fields: [modelDeployment.connectionId],
		references: [serviceConnection.id]
	}),
}));

export const agentRunEventRelations = relations(agentRunEvent, ({one}) => ({
	agentRun: one(agentRun, {
		fields: [agentRunEvent.runId],
		references: [agentRun.id]
	}),
}));

export const hermesRuntimeNodeRelations = relations(hermesRuntimeNode, ({one, many}) => ({
	serviceConnection: one(serviceConnection, {
		fields: [hermesRuntimeNode.serviceConnectionId],
		references: [serviceConnection.id]
	}),
	hermesNodeRequestNonces: many(hermesNodeRequestNonce),
	hermesNodeEnrollments: many(hermesNodeEnrollment),
	hermesCorpusSnapshots: many(hermesCorpusSnapshot),
	hermesCorpusEntries: many(hermesCorpusEntry),
	hermesCorpusMutations: many(hermesCorpusMutation),
	hermesCorpusRevisions: many(hermesCorpusRevision),
}));

export const hermesCorpusSnapshotRelations = relations(hermesCorpusSnapshot, ({one, many}) => ({
	hermesRuntimeNode: one(hermesRuntimeNode, { fields: [hermesCorpusSnapshot.nodeId], references: [hermesRuntimeNode.id] }),
	hermesCorpusEntries: many(hermesCorpusEntry),
}));

export const hermesCorpusEntryRelations = relations(hermesCorpusEntry, ({one, many}) => ({
	hermesRuntimeNode: one(hermesRuntimeNode, { fields: [hermesCorpusEntry.nodeId], references: [hermesRuntimeNode.id] }),
	lastSnapshot: one(hermesCorpusSnapshot, { fields: [hermesCorpusEntry.lastSnapshotId], references: [hermesCorpusSnapshot.id] }),
	hermesCorpusRevisions: many(hermesCorpusRevision),
}));

export const hermesCorpusMutationRelations = relations(hermesCorpusMutation, ({one, many}) => ({
	hermesRuntimeNode: one(hermesRuntimeNode, { fields: [hermesCorpusMutation.nodeId], references: [hermesRuntimeNode.id] }),
	hermesCorpusRevisions: many(hermesCorpusRevision),
}));

export const hermesCorpusRevisionRelations = relations(hermesCorpusRevision, ({one}) => ({
	hermesRuntimeNode: one(hermesRuntimeNode, { fields: [hermesCorpusRevision.nodeId], references: [hermesRuntimeNode.id] }),
	hermesCorpusEntry: one(hermesCorpusEntry, { fields: [hermesCorpusRevision.entryId], references: [hermesCorpusEntry.id] }),
	hermesCorpusMutation: one(hermesCorpusMutation, { fields: [hermesCorpusRevision.mutationId], references: [hermesCorpusMutation.id] }),
}));

export const hermesNodeRequestNonceRelations = relations(hermesNodeRequestNonce, ({one}) => ({
	hermesRuntimeNode: one(hermesRuntimeNode, {
		fields: [hermesNodeRequestNonce.nodeId],
		references: [hermesRuntimeNode.id]
	}),
}));

export const hermesNodeEnrollmentRelations = relations(hermesNodeEnrollment, ({one}) => ({
	hermesRuntimeNode: one(hermesRuntimeNode, {
		fields: [hermesNodeEnrollment.nodeId],
		references: [hermesRuntimeNode.id]
	}),
}));

export const agentRunApprovalRelations = relations(agentRunApproval, ({one}) => ({
	agentRun: one(agentRun, {
		fields: [agentRunApproval.runId],
		references: [agentRun.id]
	}),
}));
