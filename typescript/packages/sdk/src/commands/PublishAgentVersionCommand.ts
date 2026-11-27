// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { PublishAgentVersionInput, PublishAgentVersionOutput } from "../models/models_0";
import { PublishAgentVersion$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link PublishAgentVersionCommand}.
 */
export interface PublishAgentVersionCommandInput extends PublishAgentVersionInput {}
/**
 * @public
 *
 * The output of {@link PublishAgentVersionCommand}.
 */
export interface PublishAgentVersionCommandOutput extends PublishAgentVersionOutput, __MetadataBearer {}

/**
 * Publishes a version: live then points at it.
 *
 * Called on `draft`, it first keeps the draft as a new version named `name`, then points live at it,
 * so live always names a version. The publish permission alone is enough for both: publishing the
 * draft needs no permission to create versions, which SaveDraftVersion needs to keep a version
 * without making it live. Called on a named version, it points live at that version, which
 * rolls back when live pointed at it before: nothing is copied, and the history entry's `kind` is
 * `rollback`. Versions never change once made, so live answers exactly as the version it names.
 *
 * Two publishes cannot silently overwrite each other when the caller says what it expects live to
 * be: `expectedLive` names the version (or `none` before the first publish), or `If-Match` carries
 * live's ETag. Either, when stale, is refused with 412; with neither, the publish applies to live as
 * it is. Returns live, the version published, and the history entry the publish wrote.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, PublishAgentVersionCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, PublishAgentVersionCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // PublishAgentVersionInput
 *   agentId: "STRING_VALUE", // required
 *   version: "STRING_VALUE", // required
 *   idempotencyKey: "STRING_VALUE",
 *   ifMatch: "STRING_VALUE",
 *   expectedLive: "STRING_VALUE",
 *   name: "STRING_VALUE",
 *   note: "STRING_VALUE",
 * };
 * const command = new PublishAgentVersionCommand(input);
 * const response = await client.send(command);
 * // { // PublishAgentVersionOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   etag: "STRING_VALUE", // required
 * //   live: { // LiveState
 * //     version: "STRING_VALUE", // required
 * //     publishedAt: new Date("TIMESTAMP"), // required
 * //     publishedBy: { // Actor
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //   },
 * //   version: { // AgentVersion
 * //     agentId: "STRING_VALUE", // required
 * //     name: "STRING_VALUE", // required
 * //     liveVersion: "STRING_VALUE",
 * //     source: "save" || "publish" || "migration" || "import",
 * //     basedOn: "STRING_VALUE",
 * //     matchesLive: true || false,
 * //     createdAt: new Date("TIMESTAMP"), // required
 * //     createdBy: {
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //     publishedAt: new Date("TIMESTAMP"),
 * //     publishedBy: {
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //     note: "STRING_VALUE",
 * //     changedMembers: [ // ConfigurationPathList
 * //       "STRING_VALUE",
 * //     ],
 * //     configuration: { // AgentConfiguration
 * //       guidance: { // AgentGuidance
 * //         identity: "STRING_VALUE",
 * //         instructions: "STRING_VALUE",
 * //         relevance: "STRING_VALUE",
 * //         definitions: "STRING_VALUE",
 * //         searchTopics: "STRING_VALUE",
 * //         resultEvaluation: "STRING_VALUE",
 * //         limitedEvidence: "STRING_VALUE",
 * //       },
 * //       models: { // AgentModels
 * //         answer: { // AnswerModelSettings
 * //           model: "STRING_VALUE",
 * //           temperature: Number("float"),
 * //           topP: Number("float"),
 * //           topK: Number("int"),
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //           reasoning: { // ReasoningSettings
 * //             enabled: true || false,
 * //             effort: "low" || "medium" || "high" || "xhigh" || "max",
 * //           },
 * //           maxContinuations: Number("int"),
 * //         },
 * //         planning: { // ModelSettings
 * //           model: "STRING_VALUE",
 * //           temperature: Number("float"),
 * //           topP: Number("float"),
 * //           topK: Number("int"),
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //           reasoning: {
 * //             enabled: true || false,
 * //             effort: "low" || "medium" || "high" || "xhigh" || "max",
 * //           },
 * //         },
 * //         summary: {
 * //           model: "STRING_VALUE",
 * //           temperature: Number("float"),
 * //           topP: Number("float"),
 * //           topK: Number("int"),
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //           reasoning: {
 * //             enabled: true || false,
 * //             effort: "low" || "medium" || "high" || "xhigh" || "max",
 * //           },
 * //         },
 * //         classification: {
 * //           model: "STRING_VALUE",
 * //           temperature: Number("float"),
 * //           topP: Number("float"),
 * //           topK: Number("int"),
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //           reasoning: {
 * //             enabled: true || false,
 * //             effort: "low" || "medium" || "high" || "xhigh" || "max",
 * //           },
 * //         },
 * //         searchTopics: {
 * //           model: "STRING_VALUE",
 * //           temperature: Number("float"),
 * //           topP: Number("float"),
 * //           topK: Number("int"),
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //           reasoning: {
 * //             enabled: true || false,
 * //             effort: "low" || "medium" || "high" || "xhigh" || "max",
 * //           },
 * //         },
 * //         title: { // TitleModelSettings
 * //           model: "STRING_VALUE",
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //         },
 * //       },
 * //       knowledgeBases: [ // KnowledgeBaseBindingList
 * //         { // KnowledgeBaseBinding
 * //           knowledgeBaseId: "STRING_VALUE", // required
 * //           description: "STRING_VALUE",
 * //           maxQueries: Number("int"),
 * //           numberOfResults: Number("int"),
 * //           minimumScore: Number("float"),
 * //           minimumRelevance: Number("float"),
 * //           transcriptPanel: true || false,
 * //           evaluation: { // ResultEvaluation
 * //             method: "reranker" || "model",
 * //             maxSearchResults: Number("int"),
 * //             maxResults: Number("int"),
 * //             judge: {
 * //               model: "STRING_VALUE",
 * //               temperature: Number("float"),
 * //               topP: Number("float"),
 * //               topK: Number("int"),
 * //               maxOutputTokens: Number("int"),
 * //               maxAttempts: Number("int"),
 * //               reasoning: "<ReasoningSettings>",
 * //             },
 * //             reranker: "STRING_VALUE",
 * //           },
 * //         },
 * //       ],
 * //       policies: [ // PolicyBindingList
 * //         { // PolicyBinding
 * //           policyId: "STRING_VALUE", // required
 * //         },
 * //       ],
 * //       connectors: [ // ConnectorBindingList
 * //         { // ConnectorBinding
 * //           connectorId: "STRING_VALUE", // required
 * //         },
 * //       ],
 * //       workflow: { // AgentWorkflow
 * //         entryPhase: "STRING_VALUE",
 * //         phases: [ // PhaseList
 * //           { // Phase
 * //             id: "STRING_VALUE", // required
 * //             kind: "conversational" || "gather_info" || "take_action" || "policy_review", // required
 * //             instructions: "STRING_VALUE",
 * //             tools: [ // PhaseToolList
 * //               { // PhaseTool
 * //                 name: "STRING_VALUE",
 * //                 mcpServerId: "STRING_VALUE",
 * //                 tools: [ // ToolNameList
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 excludedTools: [
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 description: "STRING_VALUE",
 * //                 enabled: true || false,
 * //                 use: "answer" || "context" || "default",
 * //                 citationLabel: "STRING_VALUE",
 * //                 search: { // ToolSearchSettings
 * //                   modes: [ // SearchModeList // required
 * //                     "evaluated" || "unevaluated",
 * //                   ],
 * //                   version: "STRING_VALUE", // required
 * //                 },
 * //               },
 * //             ],
 * //             transitions: [ // PhaseTransitionList
 * //               { // PhaseTransition
 * //                 to: "STRING_VALUE", // required
 * //                 condition: "STRING_VALUE", // required
 * //                 kind: "completion" || "alternative" || "skip",
 * //                 skipLabel: "STRING_VALUE",
 * //                 requiresUserChoice: true || false,
 * //                 when: { // TransitionMatch
 * //                   source: "tool_result" || "saved_field",
 * //                   field: "STRING_VALUE", // required
 * //                   equals: "DOCUMENT_VALUE", // required
 * //                 },
 * //                 handover: "STRING_VALUE",
 * //                 startedIn: [ // PhaseIdList
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 notStartedIn: [
 * //                   "STRING_VALUE",
 * //                 ],
 * //               },
 * //             ],
 * //             maxSteps: Number("int"),
 * //             reasoning: "<ReasoningSettings>",
 * //             opening: { // PhaseOpening
 * //               message: "STRING_VALUE",
 * //               input: "DOCUMENT_VALUE",
 * //               onEveryEntry: true || false,
 * //             },
 * //             step: { // JourneyStep
 * //               id: "STRING_VALUE", // required
 * //               label: "STRING_VALUE", // required
 * //               doneWhen: "STRING_VALUE",
 * //             },
 * //             onEnd: { // PhaseEnd
 * //               type: "restart" || "close", // required
 * //               restartIn: "STRING_VALUE",
 * //               closingMessage: "STRING_VALUE",
 * //             },
 * //             unattended: true || false,
 * //             repliesOnEntry: true || false,
 * //             toolCallChecks: { // ToolCallChecks
 * //               policy: "STRING_VALUE", // required
 * //               model: "STRING_VALUE",
 * //               maxRetries: Number("int"),
 * //             },
 * //             attributionChecks: { // AttributionChecks
 * //               model: "STRING_VALUE",
 * //               maxRetries: Number("int"),
 * //               mode: "record" || "enforce",
 * //             },
 * //             fields: [ // PhaseFieldList
 * //               { // PhaseField
 * //                 id: "STRING_VALUE", // required
 * //                 kind: "field" || "prerequisite",
 * //                 description: "STRING_VALUE",
 * //                 request: "STRING_VALUE",
 * //                 optional: true || false,
 * //                 type: "text" || "document",
 * //                 acceptedTypes: [ // DocumentExtensionList
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 maxByteSize: Number("long"),
 * //                 documentField: "STRING_VALUE",
 * //                 sources: [ // FieldSourceList
 * //                   { // FieldSource
 * //                     kind: "tool_result" || "allowed_values" || "earlier_phase" || "person", // required
 * //                     toolName: "STRING_VALUE",
 * //                     path: "STRING_VALUE",
 * //                     values: [ // AllowedValueList
 * //                       "STRING_VALUE",
 * //                     ],
 * //                     phase: "STRING_VALUE",
 * //                     field: "STRING_VALUE",
 * //                   },
 * //                 ],
 * //                 prerequisite: "STRING_VALUE",
 * //               },
 * //             ],
 * //             next: "STRING_VALUE",
 * //             handover: "STRING_VALUE",
 * //             outcomeDescription: "STRING_VALUE",
 * //             responses: [ // PhaseResponseList
 * //               { // PhaseResponse
 * //                 id: "STRING_VALUE", // required
 * //                 description: "STRING_VALUE", // required
 * //                 request: "STRING_VALUE", // required
 * //               },
 * //             ],
 * //             action: { // PhaseAction
 * //               description: "STRING_VALUE", // required
 * //               requiredTools: [
 * //                 "STRING_VALUE",
 * //               ],
 * //               completesOnRequiredTool: true || false,
 * //             },
 * //             policyRules: [ // PolicyRuleRefList
 * //               "STRING_VALUE",
 * //             ],
 * //             review: { // PolicyReviewSettings
 * //               policyId: "STRING_VALUE", // required
 * //               ruleIds: [ // PolicyRuleIdList
 * //                 "STRING_VALUE",
 * //               ],
 * //               reviewStageId: "STRING_VALUE",
 * //             },
 * //           },
 * //         ],
 * //         capabilities: [ // CapabilityList
 * //           { // Capability
 * //             id: "STRING_VALUE", // required
 * //             description: "STRING_VALUE", // required
 * //             instructions: "STRING_VALUE",
 * //             phases: [ // required
 * //               "STRING_VALUE",
 * //             ],
 * //             conversationScope: "organisation" || "workspace",
 * //           },
 * //         ],
 * //       },
 * //       answers: { // AnswerSettings
 * //         followUpQuestions: true || false,
 * //         citations: { // CitationSettings
 * //           userMessages: true || false,
 * //         },
 * //         mediaEmbeds: { // MediaEmbedSettings
 * //           enabled: true || false,
 * //           reservedResults: Number("int"),
 * //         },
 * //       },
 * //       conversation: { // ConversationSettings
 * //         inputPlaceholder: "STRING_VALUE",
 * //         timeZone: "STRING_VALUE",
 * //       },
 * //       attachments: { // AttachmentSettings
 * //         enabled: true || false,
 * //         maxFiles: Number("int"),
 * //         maxByteSize: Number("long"),
 * //         acceptedTypes: [
 * //           "STRING_VALUE",
 * //         ],
 * //       },
 * //       contentSafety: { // ContentSafety
 * //         guardrail: "STRING_VALUE",
 * //       },
 * //       deniedDocuments: true || false,
 * //       memory: { // MemorySettings
 * //         enabled: true || false,
 * //         memoryStoreId: "STRING_VALUE",
 * //         minimumRelevance: Number("float"),
 * //         maxResults: Number("int"),
 * //         preferences: true || false,
 * //         summaries: true || false,
 * //       },
 * //       voice: { // VoiceSettings
 * //         provider: "browser" || "cloud",
 * //         voiceId: "STRING_VALUE",
 * //         quality: "natural" || "standard",
 * //         language: "STRING_VALUE",
 * //       },
 * //       liveAvatar: { // LiveAvatarSettings
 * //         provider: "heygen",
 * //         secretId: "STRING_VALUE", // required
 * //         answerVersion: "STRING_VALUE",
 * //         triggerPhrases: [ // PhraseList // required
 * //           "STRING_VALUE",
 * //         ],
 * //         avatarId: "STRING_VALUE", // required
 * //         voiceId: "STRING_VALUE", // required
 * //         contextId: "STRING_VALUE", // required
 * //         language: "STRING_VALUE", // required
 * //         holdingPhrases: { // HoldingPhrases
 * //           openers: [
 * //             "STRING_VALUE",
 * //           ],
 * //           groups: [ // PhraseGroupList
 * //             "<PhraseList>",
 * //           ],
 * //           stillProcessing: "STRING_VALUE",
 * //           followUp: "STRING_VALUE",
 * //           intervalMs: Number("int"),
 * //           skipChance: Number("float"),
 * //         },
 * //         muteWhileSpeaking: true || false,
 * //         speechToText: "deepgram" || "assembly_ai" || "gladia" || "elevenlabs",
 * //         inactivityTimeoutMs: Number("long"),
 * //         videoAlignment: "STRING_VALUE",
 * //         voiceTuning: { // AvatarVoiceTuning
 * //           speed: Number("float"),
 * //           model: "STRING_VALUE",
 * //           stability: Number("float"),
 * //           style: Number("float"),
 * //         },
 * //         pauseAndResume: { // PauseAndResume
 * //           openingIntro: "STRING_VALUE", // required
 * //           resumeIntro: "STRING_VALUE", // required
 * //           pausedTimeoutMs: Number("int"),
 * //         },
 * //       },
 * //       journey: { // JourneySettings
 * //         poster: { // JourneyPoster
 * //           label: "STRING_VALUE", // required
 * //           footer: [ // JourneyLineList
 * //             "STRING_VALUE",
 * //           ],
 * //         },
 * //         start: { // JourneyIntroduction
 * //           eyebrow: "STRING_VALUE",
 * //           title: "STRING_VALUE", // required
 * //           lead: "STRING_VALUE",
 * //           buttonLabel: "STRING_VALUE", // required
 * //         },
 * //         resume: {
 * //           eyebrow: "STRING_VALUE",
 * //           title: "STRING_VALUE", // required
 * //           lead: "STRING_VALUE",
 * //           buttonLabel: "STRING_VALUE", // required
 * //         },
 * //       },
 * //       runAs: { // RunAs
 * //         roleId: "STRING_VALUE", // required
 * //       },
 * //     },
 * //     etag: "STRING_VALUE", // required
 * //   },
 * //   historyEntry: { // HistoryEntry
 * //     id: "STRING_VALUE", // required
 * //     agentId: "STRING_VALUE", // required
 * //     version: "STRING_VALUE", // required
 * //     previousVersion: "STRING_VALUE",
 * //     kind: "publish" || "rollback" || "migration", // required
 * //     changedAt: new Date("TIMESTAMP"), // required
 * //     changedBy: {
 * //       userId: "STRING_VALUE",
 * //       apiClientId: "STRING_VALUE",
 * //       displayName: "STRING_VALUE", // required
 * //     },
 * //     note: "STRING_VALUE",
 * //     changedMembers: [
 * //       "STRING_VALUE",
 * //     ],
 * //     configuration: {
 * //       guidance: {
 * //         identity: "STRING_VALUE",
 * //         instructions: "STRING_VALUE",
 * //         relevance: "STRING_VALUE",
 * //         definitions: "STRING_VALUE",
 * //         searchTopics: "STRING_VALUE",
 * //         resultEvaluation: "STRING_VALUE",
 * //         limitedEvidence: "STRING_VALUE",
 * //       },
 * //       models: {
 * //         answer: {
 * //           model: "STRING_VALUE",
 * //           temperature: Number("float"),
 * //           topP: Number("float"),
 * //           topK: Number("int"),
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //           reasoning: "<ReasoningSettings>",
 * //           maxContinuations: Number("int"),
 * //         },
 * //         planning: "<ModelSettings>",
 * //         summary: "<ModelSettings>",
 * //         classification: "<ModelSettings>",
 * //         searchTopics: "<ModelSettings>",
 * //         title: {
 * //           model: "STRING_VALUE",
 * //           maxOutputTokens: Number("int"),
 * //           maxAttempts: Number("int"),
 * //         },
 * //       },
 * //       knowledgeBases: [
 * //         {
 * //           knowledgeBaseId: "STRING_VALUE", // required
 * //           description: "STRING_VALUE",
 * //           maxQueries: Number("int"),
 * //           numberOfResults: Number("int"),
 * //           minimumScore: Number("float"),
 * //           minimumRelevance: Number("float"),
 * //           transcriptPanel: true || false,
 * //           evaluation: {
 * //             method: "reranker" || "model",
 * //             maxSearchResults: Number("int"),
 * //             maxResults: Number("int"),
 * //             judge: "<ModelSettings>",
 * //             reranker: "STRING_VALUE",
 * //           },
 * //         },
 * //       ],
 * //       policies: [
 * //         {
 * //           policyId: "STRING_VALUE", // required
 * //         },
 * //       ],
 * //       connectors: [
 * //         {
 * //           connectorId: "STRING_VALUE", // required
 * //         },
 * //       ],
 * //       workflow: {
 * //         entryPhase: "STRING_VALUE",
 * //         phases: [
 * //           {
 * //             id: "STRING_VALUE", // required
 * //             kind: "conversational" || "gather_info" || "take_action" || "policy_review", // required
 * //             instructions: "STRING_VALUE",
 * //             tools: [
 * //               {
 * //                 name: "STRING_VALUE",
 * //                 mcpServerId: "STRING_VALUE",
 * //                 tools: [
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 excludedTools: [
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 description: "STRING_VALUE",
 * //                 enabled: true || false,
 * //                 use: "answer" || "context" || "default",
 * //                 citationLabel: "STRING_VALUE",
 * //                 search: {
 * //                   modes: [ // required
 * //                     "evaluated" || "unevaluated",
 * //                   ],
 * //                   version: "STRING_VALUE", // required
 * //                 },
 * //               },
 * //             ],
 * //             transitions: [
 * //               {
 * //                 to: "STRING_VALUE", // required
 * //                 condition: "STRING_VALUE", // required
 * //                 kind: "completion" || "alternative" || "skip",
 * //                 skipLabel: "STRING_VALUE",
 * //                 requiresUserChoice: true || false,
 * //                 when: {
 * //                   source: "tool_result" || "saved_field",
 * //                   field: "STRING_VALUE", // required
 * //                   equals: "DOCUMENT_VALUE", // required
 * //                 },
 * //                 handover: "STRING_VALUE",
 * //                 startedIn: [
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 notStartedIn: [
 * //                   "STRING_VALUE",
 * //                 ],
 * //               },
 * //             ],
 * //             maxSteps: Number("int"),
 * //             reasoning: "<ReasoningSettings>",
 * //             opening: {
 * //               message: "STRING_VALUE",
 * //               input: "DOCUMENT_VALUE",
 * //               onEveryEntry: true || false,
 * //             },
 * //             step: {
 * //               id: "STRING_VALUE", // required
 * //               label: "STRING_VALUE", // required
 * //               doneWhen: "STRING_VALUE",
 * //             },
 * //             onEnd: {
 * //               type: "restart" || "close", // required
 * //               restartIn: "STRING_VALUE",
 * //               closingMessage: "STRING_VALUE",
 * //             },
 * //             unattended: true || false,
 * //             repliesOnEntry: true || false,
 * //             toolCallChecks: {
 * //               policy: "STRING_VALUE", // required
 * //               model: "STRING_VALUE",
 * //               maxRetries: Number("int"),
 * //             },
 * //             attributionChecks: {
 * //               model: "STRING_VALUE",
 * //               maxRetries: Number("int"),
 * //               mode: "record" || "enforce",
 * //             },
 * //             fields: [
 * //               {
 * //                 id: "STRING_VALUE", // required
 * //                 kind: "field" || "prerequisite",
 * //                 description: "STRING_VALUE",
 * //                 request: "STRING_VALUE",
 * //                 optional: true || false,
 * //                 type: "text" || "document",
 * //                 acceptedTypes: [
 * //                   "STRING_VALUE",
 * //                 ],
 * //                 maxByteSize: Number("long"),
 * //                 documentField: "STRING_VALUE",
 * //                 sources: [
 * //                   {
 * //                     kind: "tool_result" || "allowed_values" || "earlier_phase" || "person", // required
 * //                     toolName: "STRING_VALUE",
 * //                     path: "STRING_VALUE",
 * //                     values: [
 * //                       "STRING_VALUE",
 * //                     ],
 * //                     phase: "STRING_VALUE",
 * //                     field: "STRING_VALUE",
 * //                   },
 * //                 ],
 * //                 prerequisite: "STRING_VALUE",
 * //               },
 * //             ],
 * //             next: "STRING_VALUE",
 * //             handover: "STRING_VALUE",
 * //             outcomeDescription: "STRING_VALUE",
 * //             responses: [
 * //               {
 * //                 id: "STRING_VALUE", // required
 * //                 description: "STRING_VALUE", // required
 * //                 request: "STRING_VALUE", // required
 * //               },
 * //             ],
 * //             action: {
 * //               description: "STRING_VALUE", // required
 * //               requiredTools: "<ToolNameList>",
 * //               completesOnRequiredTool: true || false,
 * //             },
 * //             policyRules: [
 * //               "STRING_VALUE",
 * //             ],
 * //             review: {
 * //               policyId: "STRING_VALUE", // required
 * //               ruleIds: [
 * //                 "STRING_VALUE",
 * //               ],
 * //               reviewStageId: "STRING_VALUE",
 * //             },
 * //           },
 * //         ],
 * //         capabilities: [
 * //           {
 * //             id: "STRING_VALUE", // required
 * //             description: "STRING_VALUE", // required
 * //             instructions: "STRING_VALUE",
 * //             phases: "<PhaseIdList>", // required
 * //             conversationScope: "organisation" || "workspace",
 * //           },
 * //         ],
 * //       },
 * //       answers: {
 * //         followUpQuestions: true || false,
 * //         citations: {
 * //           userMessages: true || false,
 * //         },
 * //         mediaEmbeds: {
 * //           enabled: true || false,
 * //           reservedResults: Number("int"),
 * //         },
 * //       },
 * //       conversation: {
 * //         inputPlaceholder: "STRING_VALUE",
 * //         timeZone: "STRING_VALUE",
 * //       },
 * //       attachments: {
 * //         enabled: true || false,
 * //         maxFiles: Number("int"),
 * //         maxByteSize: Number("long"),
 * //         acceptedTypes: [
 * //           "STRING_VALUE",
 * //         ],
 * //       },
 * //       contentSafety: {
 * //         guardrail: "STRING_VALUE",
 * //       },
 * //       deniedDocuments: true || false,
 * //       memory: {
 * //         enabled: true || false,
 * //         memoryStoreId: "STRING_VALUE",
 * //         minimumRelevance: Number("float"),
 * //         maxResults: Number("int"),
 * //         preferences: true || false,
 * //         summaries: true || false,
 * //       },
 * //       voice: {
 * //         provider: "browser" || "cloud",
 * //         voiceId: "STRING_VALUE",
 * //         quality: "natural" || "standard",
 * //         language: "STRING_VALUE",
 * //       },
 * //       liveAvatar: {
 * //         provider: "heygen",
 * //         secretId: "STRING_VALUE", // required
 * //         answerVersion: "STRING_VALUE",
 * //         triggerPhrases: "<PhraseList>", // required
 * //         avatarId: "STRING_VALUE", // required
 * //         voiceId: "STRING_VALUE", // required
 * //         contextId: "STRING_VALUE", // required
 * //         language: "STRING_VALUE", // required
 * //         holdingPhrases: {
 * //           openers: "<PhraseList>",
 * //           groups: [
 * //             "<PhraseList>",
 * //           ],
 * //           stillProcessing: "STRING_VALUE",
 * //           followUp: "STRING_VALUE",
 * //           intervalMs: Number("int"),
 * //           skipChance: Number("float"),
 * //         },
 * //         muteWhileSpeaking: true || false,
 * //         speechToText: "deepgram" || "assembly_ai" || "gladia" || "elevenlabs",
 * //         inactivityTimeoutMs: Number("long"),
 * //         videoAlignment: "STRING_VALUE",
 * //         voiceTuning: {
 * //           speed: Number("float"),
 * //           model: "STRING_VALUE",
 * //           stability: Number("float"),
 * //           style: Number("float"),
 * //         },
 * //         pauseAndResume: {
 * //           openingIntro: "STRING_VALUE", // required
 * //           resumeIntro: "STRING_VALUE", // required
 * //           pausedTimeoutMs: Number("int"),
 * //         },
 * //       },
 * //       journey: {
 * //         poster: {
 * //           label: "STRING_VALUE", // required
 * //           footer: [
 * //             "STRING_VALUE",
 * //           ],
 * //         },
 * //         start: {
 * //           eyebrow: "STRING_VALUE",
 * //           title: "STRING_VALUE", // required
 * //           lead: "STRING_VALUE",
 * //           buttonLabel: "STRING_VALUE", // required
 * //         },
 * //         resume: {
 * //           eyebrow: "STRING_VALUE",
 * //           title: "STRING_VALUE", // required
 * //           lead: "STRING_VALUE",
 * //           buttonLabel: "STRING_VALUE", // required
 * //         },
 * //       },
 * //       runAs: {
 * //         roleId: "STRING_VALUE", // required
 * //       },
 * //     },
 * //   },
 * // };
 *
 * ```
 *
 * @param PublishAgentVersionCommandInput - {@link PublishAgentVersionCommandInput}
 * @returns {@link PublishAgentVersionCommandOutput}
 * @see {@link PublishAgentVersionCommandInput} for command's `input` shape.
 * @see {@link PublishAgentVersionCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link ConflictError} (client fault)
 *  The resource's state does not allow the request, a unique name is taken, or a request with the
 * same idempotency key is still in progress. An agent version that live points at
 * (`VERSION_IN_USE`) or that live history names (`VERSION_IN_HISTORY`) cannot be deleted. A
 * document still being ingested takes no new version (`DOCUMENT_INGESTION_IN_PROGRESS`), and an
 * ingestion batch with unresolved items cannot start (`INGESTION_BATCH_UNRESOLVED`).
 * `TARGET_IN_USE` refuses a write to a path an ingestion batch has reserved for a new document
 * (CreateDocument, or UpdateDocument renaming or moving a document onto it) while the batch holds
 * the path; once the batch's reservation has lapsed, the path is free and the write goes ahead. It
 * is also an ingestion batch item's failure when the document its plan found changed, or something
 * else took it, before the batch could act on it. `DOCUMENT_INGESTION_IN_PROGRESS` and
 * `TARGET_IN_USE` answers carry `Retry-After`: for `TARGET_IN_USE`, the seconds left on the batch's
 * reservation. A document whose versions are not numbered yet cannot have one deleted by number
 * (`VERSIONS_NOT_NUMBERED`).
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
 *
 * @throws {@link PreconditionFailedError} (client fault)
 *  `If-Match` does not match the resource's current ETag: it changed since the caller read it.
 *
 * @throws {@link UnprocessableContentError} (client fault)
 *  The idempotency key was already used with a different request body; supplied metadata does not
 * fit the knowledge base's field definitions or limits (`METADATA_FIELD_UNDEFINED`,
 * `METADATA_VALUE_INVALID`, `METADATA_FIELD_PASSAGE_SCOPED`, `METADATA_LIMIT_EXCEEDED`), with one
 * entry per field in `errors`; an ingestion batch item gives both or neither of its content's
 * description and a `fetchUrl` (`BATCH_ITEM_CONTENT_AMBIGUOUS`); or the document guardrail refused
 * a file (`CONTENT_REJECTED`); or a grant of a knowledge base to a role that guests or anonymous
 * visitors use is not safe for them (`RBAC_NOT_GUEST_SAFE`), refused for what the grant is, not
 * for what the caller lacks.
 *
 * @throws {@link InternalError} (server fault)
 *  An unexpected server failure. Not retried by the SDKs.
 *
 * @throws {@link PermissionDeniedError} (client fault)
 *  The caller may not call this operation: it lacks the permission, its credential type may not
 * call it, or the operation is served only on the organisation's primary workspace. Decided before
 * any record is read. A record the caller may not see is 404 instead.
 *
 * @throws {@link ServiceUnavailableError} (server fault)
 *  A dependency is briefly unavailable, or the request's audit event could not be recorded; wait for
 * `Retry-After` and try again.
 *
 * @throws {@link TooManyRequestsError} (client fault)
 *  Too many requests; wait for `Retry-After` and try again.
 *
 * @throws {@link UnauthenticatedError} (client fault)
 *  No credential was sent, or it is expired or not valid.
 *
 * @throws {@link ValidationError} (client fault)
 *  The request is malformed: a member is missing, the wrong type or out of range; it has a member,
 * filter or sort field the operation does not define; its cursor is not valid for this list; it
 * asks to delete `draft` or `live`, which every agent keeps; an agent configuration would be
 * larger than 256 KiB; or a file is meant for a conversation whose agent takes no attachments.
 *
 * @throws {@link CaitlynServiceException}
 * <p>Base exception class for all service exceptions from Caitlyn service.</p>
 *
 *
 * @example Publish the tested draft as a new version
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   expectedLive: "october-release",
 *   name: "november-release",
 *   note: "Quotes the policy clause it relied on.",
 *   version: "draft"
 * };
 * const command = new PublishAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"live-t-RTXuzzmm5n-5Y7"`,
 *   historyEntry: {
 *     agentId: "GHT7YRWXPL",
 *     changedAt: "2026-11-14T02:03:04.000Z",
 *     changedBy: {
 *       displayName: "Aroha Ngata",
 *       userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 *     },
 *     changedMembers: [
 *       "guidance.instructions"
 *     ],
 *     id: "0193a6f4-5a6b-7c8d-9e0f-102132435465",
 *     kind: "publish",
 *     note: "Quotes the policy clause it relied on.",
 *     previousVersion: "october-release",
 *     version: "november-release"
 *   },
 *   live: {
 *     publishedAt: "2026-11-14T02:03:04.000Z",
 *     publishedBy: {
 *       displayName: "Aroha Ngata",
 *       userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 *     },
 *     version: "november-release"
 *   },
 *   version: {
 *     agentId: "GHT7YRWXPL",
 *     basedOn: "draft",
 *     changedMembers: [
 *       "guidance.instructions"
 *     ],
 *     createdAt: "2026-11-14T02:03:04.000Z",
 *     createdBy: {
 *       displayName: "Aroha Ngata",
 *       userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 *     },
 *     etag: `"november-release-1-Qp4mLw8sZt2aXe"`,
 *     matchesLive: true,
 *     name: "november-release",
 *     note: "Quotes the policy clause it relied on.",
 *     source: "publish"
 *   }
 * }
 * *\/
 * ```
 *
 * @example Roll back to an earlier version
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   note: "The November wording confused casual staff.",
 *   version: "october-release"
 * };
 * const command = new PublishAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   etag: `"live-OX3eglzDNKzdvym8"`,
 *   historyEntry: {
 *     agentId: "GHT7YRWXPL",
 *     changedAt: "2026-11-15T21:40:00.000Z",
 *     changedBy: {
 *       displayName: "Aroha Ngata",
 *       userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 *     },
 *     id: "0193a6f9-1b2c-7d3e-8f40-516273849506",
 *     kind: "rollback",
 *     note: "The November wording confused casual staff.",
 *     previousVersion: "november-release",
 *     version: "october-release"
 *   },
 *   live: {
 *     publishedAt: "2026-11-15T21:40:00.000Z",
 *     publishedBy: {
 *       displayName: "Aroha Ngata",
 *       userId: "3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64"
 *     },
 *     version: "october-release"
 *   },
 *   version: {
 *     agentId: "GHT7YRWXPL",
 *     basedOn: "draft",
 *     createdAt: "2026-10-01T22:10:00.000Z",
 *     etag: `"october-release-1-Hn7cVb3kRd9wYu"`,
 *     matchesLive: true,
 *     name: "october-release",
 *     source: "publish"
 *   }
 * }
 * *\/
 * ```
 *
 * @example Live changed since the caller looked
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   expectedLive: "september-release",
 *   version: "october-release"
 * };
 * const command = new PublishAgentVersionCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class PublishAgentVersionCommand extends command<PublishAgentVersionCommandInput, PublishAgentVersionCommandOutput>(
  _ep0,
  _mw0,
  "PublishAgentVersion",
  PublishAgentVersion$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: PublishAgentVersionInput;
      output: PublishAgentVersionOutput;
    };
    sdk: {
      input: PublishAgentVersionCommandInput;
      output: PublishAgentVersionCommandOutput;
    };
  };
}
