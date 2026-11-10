package ai.caitlyn.codegen.model;

import java.util.LinkedHashSet;
import java.util.Optional;
import java.util.Set;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;

/**
 * The RFC 9457 {@code ProblemDetails} mixin every error structure uses (PROTOCOL.md 6.1, lint rule 2). Its
 * members are carried by the runtime cores' base error, so generated error classes add only the members
 * beyond them (for example {@code retryAfterSeconds}).
 */
public final class ProblemDetails {
    private ProblemDetails() {}

    /**
     * The mixin's member names, from {@code <service namespace>#ProblemDetails}. Codegen transforms flatten and
     * remove mixins, so on a transformed model the names are instead the members every service-level error
     * shares (lint rule 2 makes the two the same). Empty if the model has neither.
     */
    public static Set<String> memberNames(Model model, ServiceShape service) {
        ShapeId id = ShapeId.fromParts(service.getId().getNamespace(), "ProblemDetails");
        Optional<StructureShape> mixin = model.getShape(id).flatMap(s -> s.asStructureShape());
        if (mixin.isPresent()) {
            return new LinkedHashSet<>(mixin.get().getAllMembers().keySet());
        }
        Set<String> common = null;
        for (ShapeId e : service.getErrorsSet()) {
            Set<String> names = model.expectShape(e).getAllMembers().keySet();
            if (common == null) {
                common = new LinkedHashSet<>(names);
            } else {
                common.retainAll(names);
            }
        }
        return common == null ? Set.of() : common;
    }
}
