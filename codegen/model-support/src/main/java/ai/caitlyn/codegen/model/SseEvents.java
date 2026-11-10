package ai.caitlyn.codegen.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.JsonNameTrait;

/**
 * The service's {@code @sseEvents} unions (PROTOCOL.md section 5). Each union's events are its members; the
 * <b>failure</b> member is the one whose target has every {@code ProblemDetails} member (on the chat stream,
 * {@code message.failed}): it is raised as a typed error and ends the stream, so it is not an event.
 */
public final class SseEvents {

    /** One union, with its wire names, failure member and final member. */
    public record Union(UnionShape shape, List<MemberShape> events, Optional<MemberShape> failure, Optional<String> finalMember) {}

    private final Map<ShapeId, Union> unions = new LinkedHashMap<>();

    /** Build from the model as written (mixins not yet flattened is fine; members are compared by name). */
    public SseEvents(Model model, ServiceShape service) {
        Set<String> problem = ProblemDetails.memberNames(model, service);
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            Optional<ObjectNode> sse = CaitlynTraits.object(op, CaitlynTraits.SSE_EVENTS);
            if (sse.isEmpty()) {
                continue;
            }
            ShapeId id = ShapeId.from(sse.get().expectStringMember("events").getValue());
            Optional<String> fin = sse.get().getStringMember("final").map(s -> s.getValue());
            unions.computeIfAbsent(id, k -> {
                UnionShape union = model.expectShape(k, UnionShape.class);
                List<MemberShape> events = new ArrayList<>();
                MemberShape failure = null;
                for (MemberShape m : union.getAllMembers().values()) {
                    StructureShape target = model.expectShape(m.getTarget(), StructureShape.class);
                    if (!problem.isEmpty() && target.getAllMembers().keySet().containsAll(problem)) {
                        if (failure != null) {
                            throw new CodegenException(k + " has two failure members, " + failure.getMemberName() + " and " + m.getMemberName());
                        }
                        failure = m;
                    } else {
                        events.add(m);
                    }
                }
                return new Union(union, List.copyOf(events), Optional.ofNullable(failure), fin);
            });
        }
    }

    public Map<ShapeId, Union> unions() {
        return unions;
    }

    public boolean isUnion(ShapeId id) {
        return unions.containsKey(id);
    }

    /** Targets of failure members across all unions. */
    public Set<ShapeId> failureTargets() {
        return unions.values().stream().flatMap(u -> u.failure().stream()).map(MemberShape::getTarget).collect(Collectors.toSet());
    }

    /** The SSE {@code event:} name of a union member: its {@code @jsonName}, else its member name. */
    public static String wireName(MemberShape m) {
        return m.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(m.getMemberName());
    }
}
