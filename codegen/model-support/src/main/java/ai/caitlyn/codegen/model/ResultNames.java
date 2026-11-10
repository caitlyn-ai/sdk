package ai.caitlyn.codegen.model;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.UnaryOperator;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.PaginatedIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpHeaderTrait;

/**
 * Names for operation outputs, the same in every generator: a list's output is {@code <Operation>Page}; an
 * output made only of mixins, one of them not header-only, is named after that mixin minus "Body"
 * ({@code AgentVersion}); otherwise the operation's name minus its verb ({@code Upload}) when free, else
 * {@code <Operation>Result}. Outputs that are server-sent event streams get no name. Two operations may share
 * a name only when their outputs have the same members; the second is then a duplicate.
 * Must be computed from the model as written, before codegen transforms flatten mixins.
 */
public final class ResultNames {
    private static final List<String> VERBS = List.of("Create", "Get", "Update", "Put", "Delete", "List", "Describe", "Send", "Start");

    private final Map<ShapeId, String> names = new HashMap<>();
    private final Set<ShapeId> duplicates = new HashSet<>();
    private final Map<ShapeId, OperationShape> operations = new HashMap<>();

    /**
     * @param exported how the language spells a model shape name as a type, used to see which names are taken
     */
    public ResultNames(Model model, ServiceShape service, UnaryOperator<String> exported) {
        OperationIndex ops = OperationIndex.of(model);
        PaginatedIndex pages = PaginatedIndex.of(model);
        Set<String> taken = new HashSet<>();
        model.shapes().filter(s -> s.getId().getNamespace().equals(service.getId().getNamespace()))
                .filter(s -> !s.isResourceShape() && !s.isOperationShape() && !s.isServiceShape() && !s.isMemberShape())
                .forEach(s -> taken.add(exported.apply(s.getId().getName())));
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            Optional<StructureShape> out = ops.getOutputShape(op);
            if (out.isEmpty() || op.hasTrait(CaitlynTraits.SSE_EVENTS)) {
                continue;
            }
            StructureShape output = out.get();
            String name;
            if (pages.getPaginationInfo(service, op).isPresent()) {
                name = op.getId().getName() + "Page";
            } else {
                name = mixinName(model, output).orElseGet(() -> {
                    String stripped = stripVerb(op.getId().getName());
                    return stripped != null && !taken.contains(stripped) ? stripped : op.getId().getName() + "Result";
                });
            }
            for (Map.Entry<ShapeId, String> e : names.entrySet()) {
                if (e.getValue().equals(name)) {
                    StructureShape other = model.expectShape(e.getKey(), StructureShape.class);
                    if (!other.getAllMembers().keySet().equals(output.getAllMembers().keySet())) {
                        throw new CodegenException("Result name " + name + " would be shared by different shapes " + e.getKey() + " and " + output.getId());
                    }
                    duplicates.add(output.getId());
                }
            }
            names.put(output.getId(), name);
            operations.putIfAbsent(output.getId(), op);
            taken.add(name);
        }
    }

    public Map<ShapeId, String> names() {
        return names;
    }

    public Set<ShapeId> duplicates() {
        return duplicates;
    }

    /** The first operation whose output the shape is. */
    public Optional<OperationShape> operationOf(ShapeId output) {
        return Optional.ofNullable(operations.get(output));
    }

    private static Optional<String> mixinName(Model model, StructureShape output) {
        boolean ownMembers = output.getAllMembers().values().stream()
                .anyMatch(m -> output.getMixins().stream().noneMatch(mx -> model.expectShape(mx).getMember(m.getMemberName()).isPresent()));
        if (ownMembers || output.getMixins().isEmpty()) {
            return Optional.empty();
        }
        List<Shape> bodyMixins = new ArrayList<>();
        for (ShapeId mx : output.getMixins()) {
            Shape mixin = model.expectShape(mx);
            if (!mixin.members().stream().allMatch(m -> m.hasTrait(HttpHeaderTrait.class))) {
                bodyMixins.add(mixin);
            }
        }
        if (bodyMixins.size() != 1) {
            return Optional.empty();
        }
        String n = bodyMixins.get(0).getId().getName();
        return Optional.of(n.endsWith("Body") ? n.substring(0, n.length() - 4) : n);
    }

    private static String stripVerb(String op) {
        for (String v : VERBS) {
            if (op.startsWith(v) && op.length() > v.length() && Character.isUpperCase(op.charAt(v.length()))) {
                return op.substring(v.length());
            }
        }
        return null;
    }
}
