// smithy-typescript generated code
import type { MetadataBearer as __MetadataBearer } from "@smithy/types";

import { _ep0, _mw0, command } from "../commandBuilder";
import type { GetHistoryEntryInput, GetHistoryEntryOutput } from "../models/models_0";
import { GetHistoryEntry$ } from "../schemas/schemas_0";

/**
 * @public
 */
export type { __MetadataBearer };
/**
 * @public
 *
 * The input for {@link GetHistoryEntryCommand}.
 */
export interface GetHistoryEntryCommandInput extends GetHistoryEntryInput {}
/**
 * @public
 *
 * The output of {@link GetHistoryEntryCommand}.
 */
export interface GetHistoryEntryCommandOutput extends GetHistoryEntryOutput, __MetadataBearer {}

/**
 * Gets one live history entry, with the configuration live had after the change.
 *
 * The configuration is that of the entry's `version`, which never changes. Reading the entry (who
 * changed live, when, and to which version) needs agent read; its `configuration` needs what
 * reading that version needs, so a caller without the agent's version access grant gets the entry
 * without it unless the version is live now. It is also absent when that version was deleted
 * through an older API that does not protect versions named in live history.
 * @example
 * Use a bare-bones client and the command you need to make an API call.
 * ```javascript
 * import { CaitlynClient, GetHistoryEntryCommand } from "@caitlyn-ai/sdk"; // ES Modules import
 * // const { CaitlynClient, GetHistoryEntryCommand } = require("@caitlyn-ai/sdk"); // CommonJS import
 * // import type { CaitlynClientConfig } from "@caitlyn-ai/sdk";
 * const config = {}; // type is CaitlynClientConfig
 * const client = new CaitlynClient(config);
 * const input = { // GetHistoryEntryInput
 *   agentId: "STRING_VALUE", // required
 *   historyEntryId: "STRING_VALUE", // required
 * };
 * const command = new GetHistoryEntryCommand(input);
 * const response = await client.send(command);
 * // { // GetHistoryEntryOutput
 * //   requestId: "STRING_VALUE",
 * //   apiVersion: "STRING_VALUE",
 * //   historyEntry: { // HistoryEntry
 * //     id: "STRING_VALUE", // required
 * //     agentId: "STRING_VALUE", // required
 * //     version: "STRING_VALUE", // required
 * //     previousVersion: "STRING_VALUE",
 * //     kind: "publish" || "rollback" || "migration", // required
 * //     changedAt: new Date("TIMESTAMP"), // required
 * //     changedBy: { // Actor
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
 * //   },
 * // };
 *
 * ```
 *
 * @param GetHistoryEntryCommandInput - {@link GetHistoryEntryCommandInput}
 * @returns {@link GetHistoryEntryCommandOutput}
 * @see {@link GetHistoryEntryCommandInput} for command's `input` shape.
 * @see {@link GetHistoryEntryCommandOutput} for command's `response` shape.
 * @see {@link CaitlynClientResolvedConfig | config} for CaitlynClient's `config` shape.
 *
 * @throws {@link NotFoundError} (client fault)
 *  The record does not exist, or the caller may not see it. The two are deliberately the same, so
 * identifiers cannot be probed.
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
 * @example Live as it was after the November publish
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   historyEntryId: "0193a6f4-5a6b-7c8d-9e0f-102132435465"
 * };
 * const command = new GetHistoryEntryCommand(input);
 * const response = await client.send(command);
 * /* response is
 * {
 *   historyEntry: {
 *     agentId: "GHT7YRWXPL",
 *     changedAt: "2026-11-14T02:03:04.000Z",
 *     changedBy: {
 *       apiClientId: "cl_7Qm2xR9vK4",
 *       displayName: "Release pipeline"
 *     },
 *     changedMembers: [
 *       "guidance.instructions"
 *     ],
 *     configuration: {
 *       guidance: {
 *         instructions: "Answer leave and pay questions. Quote the policy clause you relied on."
 *       },
 *       models: {
 *         answer: {
 *           model: "claude-sonnet-5-5"
 *         }
 *       }
 *     },
 *     id: "0193a6f4-5a6b-7c8d-9e0f-102132435465",
 *     kind: "publish",
 *     previousVersion: "october-release",
 *     version: "november-release"
 *   }
 * }
 * *\/
 * ```
 *
 * @example An entry that does not exist, or that the caller may not see
 * ```javascript
 * //
 * const input = {
 *   agentId: "GHT7YRWXPL",
 *   historyEntryId: "0193a6f4-0000-7000-8000-000000000000"
 * };
 * const command = new GetHistoryEntryCommand(input);
 * const response = await client.send(command);
 * /* response is
 * { /* metadata only *\/ }
 * *\/
 * ```
 *
 * @public
 */
export class GetHistoryEntryCommand extends command<GetHistoryEntryCommandInput, GetHistoryEntryCommandOutput>(
  _ep0,
  _mw0,
  "GetHistoryEntry",
  GetHistoryEntry$
) {
  /** @internal type navigation helper, not in runtime. */
  protected declare static __types: {
    api: {
      input: GetHistoryEntryInput;
      output: GetHistoryEntryOutput;
    };
    sdk: {
      input: GetHistoryEntryCommandInput;
      output: GetHistoryEntryCommandOutput;
    };
  };
}
