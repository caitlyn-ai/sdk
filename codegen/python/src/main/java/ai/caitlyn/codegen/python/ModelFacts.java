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
import software.amazon.smithy.codegen.core.CodegenException;
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
    /** Outputs that return a thing (ResultNames.payloadOf): the call returns the payload's own type. */
    final Map<ShapeId, MemberShape> payloads = new HashMap<>();
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
    /**
     * The structure a problem body's {@code errors} list holds (FieldError). The runtime reads it with the rest of
     * the problem details, so models.py re-exports caitlyn_core's class instead of generating one.
     */
    final java.util.Optional<ShapeId> fieldError;
    /**
     * The members a nested {@code @uploadTarget} path ends on ({@code avatar.mark.pictureUploadId}): their models take a
     * file as well as an upload's id, and the operation's method uploads the file first (PROTOCOL.md 10).
     */
    final Set<ShapeId> uploadFileMembers = new HashSet<>();
    /** Highest @since in the service: the Caitlyn release the SDK is generated against. */
    final String apiVersion;
    /** The client as scopes (PROTOCOL.md 10), computed once in model-support for every generator. */
    final ai.caitlyn.codegen.model.ScopeTree tree;

    ModelFacts(Model model, ShapeId serviceId) {
        ServiceShape service = model.expectShape(serviceId, ServiceShape.class);
        OperationIndex ops = OperationIndex.of(model);
        PaginatedIndex pages = PaginatedIndex.of(model);
        ResultNames results = new ResultNames(model, service, UnaryOperator.identity());
        resultNames = results.names();
        duplicateResults = results.duplicates();
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            ops.getOutputShape(op).ifPresent(out -> results.payloadOf(out.getId()).ifPresent(m -> payloads.put(out.getId(), m)));
        }
        sse = new SseEvents(model, service);
        sseUnions = sse.unions().keySet();
        apiVersion = Versions.modelVersion(model, service);
        tree = ai.caitlyn.codegen.model.ScopeTree.of(model, service);
        problemFields.addAll(ProblemDetails.memberNames(model, service));
        problemFields.add("retryAfterSeconds");
        fieldError = service.getErrorsSet().stream()
                .flatMap(e -> model.expectShape(e).getMember("errors").stream())
                .flatMap(m -> model.expectShape(m.getTarget()).asListShape().stream())
                .map(l -> l.getMember().getTarget())
                .findFirst();

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
            java.util.Collection<MemberShape> members = model.expectShape(unionId).getAllMembers().values();
            for (MemberShape m : members) {
                String target = m.getTarget().getName();
                // One structure behind several events of a stream (DocumentChanged is document.created and
                // document.updated): each event's class is named after its member (DocumentCreatedEvent).
                boolean shared = members.stream().filter(o -> o.getTarget().equals(m.getTarget())).count() > 1;
                String base = shared ? Character.toUpperCase(m.getMemberName().charAt(0)) + m.getMemberName().substring(1) : target;
                eventClassNames.put(m.getId(), base.endsWith("Event") ? base : base + "Event");
                boolean usedElsewhere = model.getMemberShapes().stream()
                        .anyMatch(o -> o.getTarget().equals(m.getTarget()) && !sseUnions.contains(o.getContainer()));
                if (!usedElsewhere) {
                    sseOnlyStructures.add(m.getTarget());
                }
            }
        }
        // A structure the model already names ...Event (the workspace stream's MessageCompletedEvent) can clash with
        // the class another stream's event gets (the conversation stream's MessageCompleted is MessageCompletedEvent).
        // In a union with such a clash, every class named after a ...Event structure is prefixed with the union's
        // name (WorkspaceMessageCompletedEvent, WorkspaceConversationCreatedEvent), so the union's classes read
        // alike and the names that already shipped do not change.
        Map<String, Long> uses = eventClassNames.values().stream()
                .collect(java.util.stream.Collectors.groupingBy(n -> n, java.util.stream.Collectors.counting()));
        Set<ShapeId> clashing = new HashSet<>();
        for (Map.Entry<ShapeId, String> e : eventClassNames.entrySet()) {
            MemberShape m = model.expectShape(e.getKey(), MemberShape.class);
            if (uses.get(e.getValue()) > 1 && m.getTarget().getName().endsWith("Event")) {
                clashing.add(m.getContainer());
            }
        }
        for (Map.Entry<ShapeId, String> e : eventClassNames.entrySet()) {
            MemberShape m = model.expectShape(e.getKey(), MemberShape.class);
            if (clashing.contains(m.getContainer()) && m.getTarget().getName().endsWith("Event")) {
                e.setValue(m.getContainer().getName().replaceFirst("Event$", "") + e.getValue());
            }
        }
        // One class may serve several unions only when it is the same event: the same structure and SSE name
        // (stream.reset is on both the conversation and the workspace stream).
        Map<String, String> eventByClass = new HashMap<>();
        for (Map.Entry<ShapeId, String> e : eventClassNames.entrySet()) {
            MemberShape m = model.expectShape(e.getKey(), MemberShape.class);
            String event = m.getTarget() + " " + SseEvents.wireName(m);
            String prev = eventByClass.putIfAbsent(e.getValue(), event);
            if (prev != null && !prev.equals(event)) {
                throw new CodegenException("two SSE events would get the Python class name " + e.getValue() + ": " + prev + " and " + event);
            }
        }
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            CaitlynTraits.stringMember(op, CaitlynTraits.UPLOAD_TARGET, "member").filter(m -> m.contains(".")).ifPresent(path -> {
                StructureShape at = ops.expectInputShape(op);
                String[] parts = path.split("\\.");
                for (int i = 0; i < parts.length; i++) {
                    String seg = parts[i];
                    MemberShape m = at.getAllMembers().get(seg);
                    if (m == null) {
                        throw new CodegenException(op.getId() + ": @uploadTarget " + path + ": no member " + seg);
                    }
                    if (i == parts.length - 1) {
                        uploadFileMembers.add(m.getId());
                    } else {
                        at = model.expectShape(m.getTarget()).asStructureShape()
                                .orElseThrow(() -> new CodegenException(op.getId() + ": @uploadTarget " + path + " walks into a non-structure at " + seg));
                    }
                }
            });
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
        return !inputs.contains(s.getId()) && !streamingOutputs.contains(s.getId()) && !payloads.containsKey(s.getId())
                && !duplicateResults.contains(s.getId()) && !sseOnlyStructures.contains(s.getId())
                && !s.hasTrait(MixinTrait.class) && !s.hasTrait(ErrorTrait.class);
    }
}
