package ai.caitlyn.codegen.python;

import software.amazon.smithy.codegen.core.Symbol;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeType;
import software.amazon.smithy.model.traits.ErrorTrait;

/**
 * Shapes to Python symbols. Named shapes live in {@code <pkg>.models}, {@code <pkg>.errors} and
 * {@code <pkg>.events}; simple shapes map to builtins. Composite type expressions (lists, maps,
 * optional members) are built by {@link TypeHints} from these symbols.
 */
final class PythonSymbolProvider implements SymbolProvider {
    private final Model model;
    private final PythonSettings settings;
    private final ModelFacts facts;

    PythonSymbolProvider(Model model, PythonSettings settings, ModelFacts facts) {
        this.model = model;
        this.settings = settings;
        this.facts = facts;
    }

    @Override
    public Symbol toSymbol(Shape shape) {
        return switch (shape.getType()) {
            case STRUCTURE -> structure(shape);
            case UNION -> facts.sseUnions.contains(shape.getId()) ? named(shape.getId().getName(), "events") : named(shape.getId().getName(), "models");
            case ENUM, INT_ENUM -> named(shape.getId().getName(), "models");
            case STRING -> builtin("str");
            case BOOLEAN -> builtin("bool");
            case BYTE, SHORT, INTEGER, LONG, BIG_INTEGER -> builtin("int");
            case FLOAT, DOUBLE -> builtin("float");
            case BIG_DECIMAL -> Symbol.builder().name("Decimal").namespace("decimal", ".").build();
            case TIMESTAMP -> Symbol.builder().name("datetime").namespace("datetime", ".").build();
            case BLOB -> builtin("bytes");
            case DOCUMENT -> Symbol.builder().name("JsonValue").namespace("pydantic", ".").build();
            case LIST, SET -> builtin("list");
            case MAP -> builtin("dict");
            case MEMBER -> toSymbol(model.expectShape(((MemberShape) shape).getTarget()));
            case SERVICE -> named("Caitlyn", "_client");
            case OPERATION, RESOURCE -> builtin(Names.snake(shape.getId().getName()));
            default -> throw new IllegalArgumentException("No Python symbol for " + shape.getType() + " " + shape.getId());
        };
    }

    private Symbol structure(Shape shape) {
        if (shape.hasTrait(ErrorTrait.class)) {
            return named(shape.getId().getName(), "errors");
        }
        String result = facts.resultNames.get(shape.getId());
        if (result != null) {
            return named(result, "models");
        }
        return named(shape.getId().getName(), "models");
    }

    private Symbol named(String name, String module) {
        return Symbol.builder()
                .name(name)
                .namespace(settings.module(module), ".")
                .definitionFile(settings.file(module))
                .build();
    }

    private static Symbol builtin(String name) {
        return Symbol.builder().name(name).namespace("", ".").build();
    }

    @Override
    public String toMemberName(MemberShape member) {
        return Names.field(member.getMemberName());
    }

    static boolean isSimple(ShapeType type) {
        return type.getCategory() == ShapeType.Category.SIMPLE && type != ShapeType.ENUM && type != ShapeType.INT_ENUM;
    }
}
