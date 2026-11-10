package ai.caitlyn.codegen.python;

import java.util.stream.Collectors;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.Symbol;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.EnumShape;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MapShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.UnionShape;

/**
 * Python type expressions. Model attributes use concrete types ({@code list[Document]}); method
 * parameters accept wider ones ({@code Sequence[...]}, and an enum or its string values as a
 * {@code Literal}).
 */
final class TypeHints {
    enum Mode { MODEL, INPUT }

    private final Model model;
    private final software.amazon.smithy.codegen.core.SymbolProvider symbols;
    private final ModelFacts facts;

    TypeHints(Model model, software.amazon.smithy.codegen.core.SymbolProvider symbols, ModelFacts facts) {
        this.model = model;
        this.symbols = symbols;
        this.facts = facts;
    }

    String of(MemberShape member, Mode mode, PythonWriter w) {
        return of(model.expectShape(member.getTarget()), mode, w);
    }

    String of(Shape shape, Mode mode, PythonWriter w) {
        switch (shape.getType()) {
            case LIST, SET -> {
                String inner = of(((ListShape) shape).getMember(), mode, w);
                if (mode == Mode.INPUT) {
                    w.importFrom("collections.abc", "Sequence");
                    return "Sequence[" + inner + "]";
                }
                return "list[" + inner + "]";
            }
            case MAP -> {
                MapShape map = (MapShape) shape;
                String value = of(map.getValue(), mode, w);
                if (mode == Mode.INPUT) {
                    w.importFrom("collections.abc", "Mapping");
                    return "Mapping[str, " + value + "]";
                }
                return "dict[str, " + value + "]";
            }
            case ENUM -> {
                String name = ref(symbols.toSymbol(shape), w);
                if (mode == Mode.INPUT) {
                    w.importFrom("typing", "Literal");
                    String values = ((EnumShape) shape).getEnumValues().values().stream().map(Names::pyString).collect(Collectors.joining(", "));
                    return "Literal[" + values + "] | " + name;
                }
                return name;
            }
            case UNION -> {
                if (!facts.sseUnions.contains(shape.getId())) {
                    throw new CodegenException("Non-SSE unions are not supported yet: " + shape.getId() + " (" + ((UnionShape) shape).getMemberNames() + ")");
                }
                return ref(symbols.toSymbol(shape), w);
            }
            default -> {
                return ref(symbols.toSymbol(shape), w);
            }
        }
    }

    private static String ref(Symbol s, PythonWriter w) {
        if (!s.getNamespace().isEmpty()) {
            w.importFrom(s.getNamespace(), s.getName());
        }
        return s.getName();
    }
}
