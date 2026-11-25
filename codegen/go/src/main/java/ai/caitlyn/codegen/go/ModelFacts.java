package ai.caitlyn.codegen.go;

import ai.caitlyn.codegen.model.Bindings;
import ai.caitlyn.codegen.model.CaitlynTraits;
import ai.caitlyn.codegen.model.ProblemDetails;
import ai.caitlyn.codegen.model.ResultNames;
import ai.caitlyn.codegen.model.SseEvents;
import ai.caitlyn.codegen.model.Versions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.ErrorTrait;
import software.amazon.smithy.model.traits.MixinTrait;

/**
 * Facts several generator steps need, computed once from the model as written (before the codegen
 * transforms flatten mixins, which result naming relies on). The shared rules are in model-support.
 */
final class ModelFacts {
    /** Output structure -> Go result type name (AgentVersion, Upload, CreateDocumentResult, ListDocumentsPage). */
    final Map<ShapeId, String> resultNames;
    /**
     * Outputs that return a thing (PROTOCOL.md 4, one type per thing): output -> its @httpPayload member. Such an output
     * is not generated: the call returns the payload's type (KnowledgeBase), with the header ETag and the metadata on it.
     */
    final Map<ShapeId, MemberShape> thingPayloads = new HashMap<>();
    /** The things those outputs return: each carries the response metadata of the call that read it. */
    final Set<ShapeId> things = new HashSet<>();
    /** Results another operation's result already generates. */
    final Set<ShapeId> duplicateResults;
    final Set<ShapeId> inputs = new HashSet<>();
    final Set<ShapeId> streamingOutputs = new HashSet<>();
    final SseEvents sse;
    final Set<ShapeId> sseUnions;
    /**
     * The event unions of the watches that @longRunning names (WatchKnowledgeBase's KnowledgeBaseEvent): a scope's
     * watch and wait read a thing's processing from them, so each of their events has ProcessingOf.
     */
    final Set<ShapeId> watchUnions = new HashSet<>();
    /** Structures referenced only as SSE union members: they implement the union's interface themselves. */
    final Map<ShapeId, List<ShapeId>> sseMemberOf = new HashMap<>();
    /** Targets of SSE failure members (message.failed): decoded as typed errors, not events. */
    final Set<ShapeId> sseErrorTargets;
    /** Error members the runtime's APIError already carries: the ProblemDetails mixin's, and Retry-After. */
    final Set<String> problemFields = new HashSet<>();
    /** Highest @since in the service: the Caitlyn release the SDK is generated against. */
    final String apiVersion;
    /** Each operation's @uploadTarget, resolved (PROTOCOL.md 10, Uploads). */
    final Map<ShapeId, UploadTarget> uploadTargets = new HashMap<>();
    /**
     * Nested structures that hold an @uploadTarget identifier: structure -> identifier member -> the Go file field
     * written beside it (AgentMarkInput's pictureUploadId gets PictureFile). An input's own target is written with
     * the input.
     */
    final Map<ShapeId, Map<String, String>> fileFields = new HashMap<>();

    ModelFacts(Model model, ShapeId serviceId) {
        ServiceShape service = model.expectShape(serviceId, ServiceShape.class);
        OperationIndex ops = OperationIndex.of(model);
        ResultNames results = new ResultNames(model, service, Names::exported);
        resultNames = results.names();
        duplicateResults = results.duplicates();
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            ops.getOutputShape(op).ifPresent(out -> results.payloadOf(out.getId()).ifPresent(m -> {
                thingPayloads.put(out.getId(), m);
                things.add(m.getTarget());
            }));
        }
        sse = new SseEvents(model, service);
        sseUnions = sse.unions().keySet();
        // A failure event (PROTOCOL.md 5.5) is raised as an error on a stream with a final event, and delivered as an
        // event on a watch, so it is a type of its own and a variant of its union.
        sseErrorTargets = sse.failureTargets();
        Set<ShapeId> watches = new HashSet<>();
        model.shapes().forEach(sh -> CaitlynTraits.stringMember(sh, ai.caitlyn.codegen.model.ScopeTree.LONG_RUNNING, "watch")
                .ifPresent(w -> watches.add(ShapeId.from(w))));
        for (ShapeId w : watches) {
            // Only a watch that reports processing (a knowledge base's): an unattended run's watch reports none.
            model.getShape(w).flatMap(sh -> CaitlynTraits.stringMember(sh, CaitlynTraits.SSE_EVENTS, "events"))
                    .map(ShapeId::from)
                    .filter(u -> ai.caitlyn.codegen.model.ProcessingWatch.reportsProcessing(model, model.expectShape(u, software.amazon.smithy.model.shapes.UnionShape.class)))
                    .ifPresent(watchUnions::add);
        }
        apiVersion = Versions.modelVersion(model, service);
        problemFields.addAll(ProblemDetails.memberNames(model, service));
        problemFields.add("retryAfterSeconds");
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            ops.getInputShape(op).ifPresent(in -> inputs.add(in.getId()));
            if (op.hasTrait(CaitlynTraits.SSE_EVENTS)) {
                streamingOutputs.add(ops.expectOutputShape(op).getId());
            }
        }
        for (SseEvents.Union union : sse.unions().values()) {
            // An event structure may also be an ordinary member elsewhere: the workspace stream's tool.finished
            // carries a conversation's ToolFinished as its data. It is the same type there, with no event id.
            List<MemberShape> members = new ArrayList<>(union.events());
            union.failure().ifPresent(members::add);
            for (MemberShape m : members) {
                sseMemberOf.computeIfAbsent(m.getTarget(), k -> new ArrayList<>()).add(union.shape().getId());
            }
        }
        StructureShape purpose = null;
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            if (op.hasTrait(CaitlynTraits.PRESIGNED_UPLOAD)) {
                purpose = ops.expectInputShape(op).getMember("purpose")
                        .map(m -> model.expectShape(m.getTarget(), StructureShape.class)).orElse(null);
            }
        }
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            if (!op.hasTrait(CaitlynTraits.UPLOAD_TARGET)) {
                continue;
            }
            if (purpose == null) {
                purpose = StructureShape.builder().id(ShapeId.from("ai.caitlyn.codegen#NoUploadPurpose")).build();
            }
            UploadTarget t = UploadTarget.of(model, op, purpose).orElseThrow();
            uploadTargets.put(op.getId(), t);
            if (t.nested()) {
                String prev = fileFields.computeIfAbsent(t.owner().getId(), k -> new HashMap<>()).put(t.member().getMemberName(), t.fileField());
                if (prev != null && !prev.equals(t.fileField())) {
                    throw new CodegenException(t.member().getId() + ": two upload targets give it different file fields");
                }
            }
        }
        Bindings.checkSupported(model, service);
    }

    static String wireName(MemberShape m) {
        return SseEvents.wireName(m);
    }

    static int compareVersions(String a, String b) {
        return Versions.compare(a, b);
    }

    /** Structures written to types.go (inputs live with their operation; streaming outputs become streams). */
    boolean isGenerated(StructureShape s) {
        return !inputs.contains(s.getId()) && !streamingOutputs.contains(s.getId())
                && !duplicateResults.contains(s.getId()) && !thingPayloads.containsKey(s.getId())
                && !s.hasTrait(MixinTrait.class) && !s.hasTrait(ErrorTrait.class);
    }
}
