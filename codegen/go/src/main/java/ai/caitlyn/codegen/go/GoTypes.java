package ai.caitlyn.codegen.go;

import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.Symbol;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MapShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.traits.ErrorTrait;

/**
 * Shapes to Go types. Named shapes (structures, enums, unions, errors) are symbols in the generated
 * package, in types.go or errors.go; members get Go type expressions: required members are values,
 * optional scalars and structures are pointers, lists and maps are never pointers.
 */
final class GoTypes implements SymbolProvider {
    private final Model model;
    private final ModelFacts facts;

    GoTypes(Model model, ModelFacts facts) {
        this.model = model;
        this.facts = facts;
    }

    @Override
    public Symbol toSymbol(Shape shape) {
        String file = shape.hasTrait(ErrorTrait.class) ? "errors.go" : "types.go";
        String name = switch (shape.getType()) {
            case STRUCTURE -> facts.resultNames.getOrDefault(shape.getId(), Names.exported(shape.getId().getName()));
            case ENUM, INT_ENUM, UNION -> Names.exported(shape.getId().getName());
            case MEMBER -> toSymbol(model.expectShape(((MemberShape) shape).getTarget())).getName();
            default -> Names.exported(shape.getId().getName());
        };
        return Symbol.builder().name(name).namespace("", "/").definitionFile(file).build();
    }

    @Override
    public String toMemberName(MemberShape member) {
        return Names.exported(member.getMemberName());
    }

    /** The Go type of a member: a pointer when optional and the base type is a scalar or structure. */
    String member(MemberShape m, GoWriter w) {
        String base = base(model.expectShape(m.getTarget()), w);
        if (m.isRequired() || !pointable(model.expectShape(m.getTarget()))) {
            return base;
        }
        return "*" + base;
    }

    /** A member's base type (no pointer). */
    String base(Shape target, GoWriter w) {
        return switch (target.getType()) {
            case STRING -> "string";
            case ENUM, INT_ENUM, STRUCTURE, UNION -> toSymbol(target).getName();
            case BOOLEAN -> "bool";
            case BYTE -> "int8";
            case SHORT -> "int16";
            case INTEGER -> "int32";
            case LONG -> "int64";
            case FLOAT -> "float32";
            case DOUBLE -> "float64";
            case TIMESTAMP -> {
                w.imp("time");
                yield "time.Time";
            }
            case BLOB -> "[]byte";
            case DOCUMENT -> "any";
            case LIST, SET -> "[]" + base(model.expectShape(((ListShape) target).getMember().getTarget()), w);
            case MAP -> {
                MapShape map = (MapShape) target;
                yield "map[" + base(model.expectShape(map.getKey().getTarget()), w) + "]" + base(model.expectShape(map.getValue().getTarget()), w);
            }
            default -> throw new CodegenException("No Go type for " + target.getType() + " " + target.getId());
        };
    }

    /** Lists, maps, blobs, documents and unions (interfaces) are already nil-able. */
    static boolean pointable(Shape target) {
        return switch (target.getType()) {
            case LIST, SET, MAP, BLOB, DOCUMENT, UNION -> false;
            default -> true;
        };
    }
}
