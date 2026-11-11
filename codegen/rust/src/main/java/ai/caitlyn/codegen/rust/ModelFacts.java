package ai.caitlyn.codegen.rust;

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
    /** Output structure -> Rust result type name (AgentVersion, Upload, CreateDocumentResult, ListDocumentsPage). */
    final Map<ShapeId, String> resultNames;
    /** Results another operation's result already generates. */
    final Set<ShapeId> duplicateResults;
    final Set<ShapeId> inputs = new HashSet<>();
    final Set<ShapeId> streamingOutputs = new HashSet<>();
    final SseEvents sse;
    final Set<ShapeId> sseUnions;
    /** Structures referenced only as SSE union members: they implement the union's interface themselves. */
    final Map<ShapeId, List<ShapeId>> sseMemberOf = new HashMap<>();
    /** Targets of SSE failure members (message.failed): decoded as typed errors, not events. */
    final Set<ShapeId> sseErrorTargets;
    /** Error members the runtime's APIError already carries: the ProblemDetails mixin's, and Retry-After. */
    final Set<String> problemFields = new HashSet<>();
    /** Highest @since in the service: the Caitlyn release the SDK is generated against. */
    final String apiVersion;

    ModelFacts(Model model, ShapeId serviceId) {
        ServiceShape service = model.expectShape(serviceId, ServiceShape.class);
        OperationIndex ops = OperationIndex.of(model);
        ResultNames results = new ResultNames(model, service, Names::pascal);
        resultNames = results.names();
        duplicateResults = results.duplicates();
        sse = new SseEvents(model, service);
        sseUnions = sse.unions().keySet();
        sseErrorTargets = sse.failureTargets();
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
            for (MemberShape m : union.events()) {
                boolean usedElsewhere = model.getMemberShapes().stream()
                        .anyMatch(o -> o.getTarget().equals(m.getTarget()) && !sseUnions.contains(o.getContainer()));
                if (usedElsewhere) {
                    throw new CodegenException(m.getId() + ": an SSE event structure used outside event unions is not supported yet");
                }
                sseMemberOf.computeIfAbsent(m.getTarget(), k -> new ArrayList<>()).add(union.shape().getId());
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

    /** Structures written to types.rs (inputs live with their operation; streaming outputs become streams). */
    boolean isGenerated(StructureShape s) {
        return !inputs.contains(s.getId()) && !streamingOutputs.contains(s.getId())
                && !duplicateResults.contains(s.getId()) && !sseErrorTargets.contains(s.getId())
                && !s.hasTrait(MixinTrait.class) && !s.hasTrait(ErrorTrait.class);
    }
}
