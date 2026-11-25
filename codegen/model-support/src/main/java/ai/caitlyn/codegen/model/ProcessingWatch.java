package ai.caitlyn.codegen.model;

import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.JsonNameTrait;

/**
 * Whether a watch's events report processing (PROTOCOL.md 16, watch.processing): its snapshot carries the jobs or the
 * progress of what is being processed, as a knowledge base's does. An unattended run's watch starts with a snapshot
 * too, of the run alone, and reports no processing, so its events get no processing accessor.
 */
public final class ProcessingWatch {
    private ProcessingWatch() {}

    /**
     * Whether a scope's wait() ends on its thing's own status rather than on jobs (an unattended run's): its watch
     * reports no processing. Such a wait returns the thing for every final status and raises none of them.
     */
    public static boolean endsOnStatus(Model model, ScopeTree.Node scope) {
        return scope.watch.map(w -> model.expectShape(w.watch()).findTrait(CaitlynTraits.SSE_EVENTS)
                .map(t -> model.expectShape(software.amazon.smithy.model.shapes.ShapeId.from(t.toNode().expectObjectNode().expectStringMember("events").getValue()), UnionShape.class))
                .map(u -> !reportsProcessing(model, u)).orElse(false)).orElse(false);
    }

    public static boolean reportsProcessing(Model model, UnionShape events) {
        for (MemberShape m : events.getAllMembers().values()) {
            String wire = m.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(m.getMemberName());
            if (!wire.equals("snapshot")) continue;
            StructureShape snapshot = model.expectShape(m.getTarget(), StructureShape.class);
            return snapshot.getMember("jobs").isPresent() || snapshot.getMember("progress").isPresent();
        }
        return false;
    }
}
