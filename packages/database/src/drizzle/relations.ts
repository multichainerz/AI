import { relations } from "drizzle-orm/relations";
import { enterpriseUser, enterpriseUserSession, serviceConnection, secretRecord, configurationRevision, chatMessage, chatFeedback, agentProfile, agentProfileVersion, document, chatConversation, agentRun, agentToolGrant, governedTool, oidcAuthorizationRequest, governedToolCall, toolApproval, toolActionDispatch, modelDeployment, evaluationRun, promptTemplate, agentRunEvent, hermesRuntimeNode, hermesNodeRequestNonce, hermesNodeEnrollment, guardrailPolicy, agentRunApproval, documentChunk } from "./schema.js";

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


export const documentRelations = relations(document, ({many}) => ({
	documentChunks: many(documentChunk),
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
	toolActionDispatches: many(toolActionDispatch),
}));

export const toolApprovalRelations = relations(toolApproval, ({one}) => ({
	governedToolCall: one(governedToolCall, {
		fields: [toolApproval.callId],
		references: [governedToolCall.id]
	}),
}));

export const toolActionDispatchRelations = relations(toolActionDispatch, ({one}) => ({
	governedToolCall: one(governedToolCall, {
		fields: [toolActionDispatch.callId],
		references: [governedToolCall.id]
	}),
}));

export const modelDeploymentRelations = relations(modelDeployment, ({one}) => ({
	serviceConnection: one(serviceConnection, {
		fields: [modelDeployment.connectionId],
		references: [serviceConnection.id]
	}),
	evaluationRun: one(evaluationRun, {
		fields: [modelDeployment.activationEvaluationId],
		references: [evaluationRun.id]
	}),
}));

export const evaluationRunRelations = relations(evaluationRun, ({many}) => ({
	modelDeployments: many(modelDeployment),
	promptTemplates: many(promptTemplate),
	guardrailPolicies: many(guardrailPolicy),
}));

export const promptTemplateRelations = relations(promptTemplate, ({one}) => ({
	evaluationRun: one(evaluationRun, {
		fields: [promptTemplate.activationEvaluationId],
		references: [evaluationRun.id]
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

export const guardrailPolicyRelations = relations(guardrailPolicy, ({one}) => ({
	evaluationRun: one(evaluationRun, {
		fields: [guardrailPolicy.activationEvaluationId],
		references: [evaluationRun.id]
	}),
}));

export const agentRunApprovalRelations = relations(agentRunApproval, ({one}) => ({
	agentRun: one(agentRun, {
		fields: [agentRunApproval.runId],
		references: [agentRun.id]
	}),
}));

export const documentChunkRelations = relations(documentChunk, ({one}) => ({
	document: one(document, {
		fields: [documentChunk.documentId],
		references: [document.id]
	}),
}));