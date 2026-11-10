package ai.caitlyn.codegen.python;

import ai.caitlyn.codegen.model.Bindings;
import ai.caitlyn.codegen.model.CaitlynTraits;
import ai.caitlyn.codegen.model.ProblemDetails;
import ai.caitlyn.codegen.model.ResultNames;
import ai.caitlyn.codegen.model.SseEvents;
import ai.caitlyn.codegen.model.Versions;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.UnaryOperator;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.PaginatedIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.DocumentationTrait;
import software.amazon.smithy.model.traits.ErrorTrait;
import software.amazon.smithy.model.traits.MixinTrait;

/**
 * Facts about the model that several generator steps need, computed once from the model as
 * written (before codegen transforms flatten mixins, which result naming relies on). The shared
 * rules are in model-support.
 */
final class ModelFacts {
    final Map<ShapeId, String> resultNames;
    /** Result classes that another operation's result already generates. */
    final Set<ShapeId> duplicateResults;
    final Set<ShapeId> inputs = new HashSet<>();
    final Set<ShapeId> streamingOutputs = new HashSet<>();
    final SseEvents sse;
    final Set<ShapeId> sseUnions;
    /** Structures referenced only as SSE union members: their event classes carry the members. */
    final Set<ShapeId> sseOnlyStructures = new HashSet<>();
    final Map<ShapeId, String> eventClassNames = new LinkedHashMap<>();
    /** Structures whose documentation comes from a mixin (so it describes the mixin, not them). */
    final Set<ShapeId> inheritedDocs = new HashSet<>();
    /** Documentation for result classes: their own, else their operation's. */
    final Map<ShapeId, String> resultDocs = new HashMap<>();
    /** Error members the runtime's CaitlynError already carries: the ProblemDetails mixin's, and Retry-After. */
    final Set<String> problemFields = new HashSet<>();
    /** Highest @since in the service: the Caitlyn release the SDK is generated against. */
    final String apiVersion;

    ModelFacts(Model model, ShapeId serviceId) {
        ServiceShape service = model.expectShape(serviceId, ServiceShape.class);
        OperationIndex ops = OperationIndex.of(model);
        PaginatedIndex pages = PaginatedIndex.of(model);
        ResultNames results = new ResultNames(model, service, UnaryOperator.identity());
        resultNames = results.names();
        duplicateResults = results.duplicates();
        sse = new SseEvents(model, service);
        sseUnions = sse.unions().keySet();
        apiVersion = Versions.modelVersion(model, service);
        problemFields.addAll(ProblemDetails.memberNames(model, service));
        problemFields.add("retryAfterSeconds");

        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            ops.getInputShape(op).ifPresent(in -> inputs.add(in.getId()));
            if (op.hasTrait(CaitlynTraits.SSE_EVENTS)) {
                ops.getOutputShape(op).ifPresent(out -> streamingOutputs.add(out.getId()));
            }
        }
        results.names().keySet().forEach(outId -> results.operationOf(outId).ifPresent(op -> {
            StructureShape output = model.expectShape(outId, StructureShape.class);
            if (!output.getIntroducedTraits().containsKey(DocumentationTrait.ID)) {
                op.getTrait(DocumentationTrait.class).ifPresent(d -> resultDocs.putIfAbsent(outId,
                        (pages.getPaginationInfo(service, op).isPresent() ? "One page of results. " : "The result: ") + d.getValue().strip()));
            }
        }));
        model.getStructureShapes().forEach(st -> {
            if (!st.getMixins().isEmpty() && st.hasTrait(DocumentationTrait.class) && !st.getIntroducedTraits().containsKey(DocumentationTrait.ID)) {
                inheritedDocs.add(st.getId());
            }
        });
        for (ShapeId unionId : sseUnions) {
            for (MemberShape m : model.expectShape(unionId).getAllMembers().values()) {
                String target = m.getTarget().getName();
                eventClassNames.put(m.getId(), target.endsWith("Event") ? target : target + "Event");
                boolean usedElsewhere = model.getMemberShapes().stream()
                        .anyMatch(o -> o.getTarget().equals(m.getTarget()) && !sseUnions.contains(o.getContainer()));
                if (!usedElsewhere) {
                    sseOnlyStructures.add(m.getTarget());
                }
            }
        }
        Bindings.checkSupported(model, service);
    }

    /** The union's failure member (PROTOCOL.md 5.5), raised as a typed error. */
    java.util.Optional<MemberShape> failureMember(ShapeId union) {
        return sse.unions().get(union).failure();
    }

    static int compareVersions(String a, String b) {
        return Versions.compare(a, b);
    }

    boolean isGenerated(StructureShape s) {
        return !inputs.contains(s.getId()) && !streamingOutputs.contains(s.getId())
                && !duplicateResults.contains(s.getId()) && !sseOnlyStructures.contains(s.getId())
                && !s.hasTrait(MixinTrait.class) && !s.hasTrait(ErrorTrait.class);
    }
}
