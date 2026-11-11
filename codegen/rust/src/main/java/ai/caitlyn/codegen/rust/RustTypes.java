package ai.caitlyn.codegen.rust;

import java.util.HashSet;
import java.util.Set;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.Symbol;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.codegen.core.TopologicalIndex;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MapShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.ErrorTrait;

/**
 * Shapes to Rust types. Named shapes (structures, enums, unions) are types in types.rs; errors are variants of the
 * crate's Error enum. Members get type expressions: required members are values, optional ones {@code Option},
 * and a structure member that can reach itself is boxed.
 */
final class RustTypes implements SymbolProvider {
    private final Model model;
    private final ModelFacts facts;
    private final Set<ShapeId> recursive = new HashSet<>();

    RustTypes(Model model, ModelFacts facts) {
        this.model = model;
        this.facts = facts;
        TopologicalIndex.of(model).getRecursiveShapes().forEach(s -> recursive.add(s.getId()));
    }

    @Override
    public Symbol toSymbol(Shape shape) {
        String file = shape.hasTrait(ErrorTrait.class) ? "src/error.rs" : "src/types.rs";
        String name = switch (shape.getType()) {
            case STRUCTURE -> facts.resultNames.getOrDefault(shape.getId(), Names.pascal(shape.getId().getName()));
            case MEMBER -> toSymbol(model.expectShape(((MemberShape) shape).getTarget())).getName();
            default -> Names.pascal(shape.getId().getName());
        };
        return Symbol.builder().name(name).namespace("crate", "::").definitionFile(file).build();
    }

    @Override
    public String toMemberName(MemberShape member) {
        return Names.snake(member.getMemberName());
    }

    /** The Rust type of a member: {@code Option<…>} when optional, boxed when the target can reach itself. */
    String member(MemberShape m) {
        Shape target = model.expectShape(m.getTarget());
        String base = base(target);
        if ((target.isStructureShape() || target.isUnionShape()) && recursive.contains(target.getId())) {
            base = "Box<" + base + ">";
        }
        return m.isRequired() ? base : "Option<" + base + ">";
    }

    /** A member's base type. */
    String base(Shape target) {
        return switch (target.getType()) {
            case STRING -> "String";
            case ENUM, STRUCTURE, UNION -> toSymbol(target).getName();
            case BOOLEAN -> "bool";
            case BYTE -> "i8";
            case SHORT -> "i16";
            case INTEGER -> "i32";
            case LONG -> "i64";
            case FLOAT -> "f32";
            case DOUBLE -> "f64";
            case TIMESTAMP -> "chrono::DateTime<chrono::Utc>";
            case DOCUMENT -> "serde_json::Value";
            case LIST, SET -> {
                Shape item = model.expectShape(((ListShape) target).getMember().getTarget());
                if (item.isTimestampShape()) {
                    throw new CodegenException(target.getId() + ": lists of timestamps are not supported yet");
                }
                yield "Vec<" + base(item) + ">";
            }
            case MAP -> {
                MapShape map = (MapShape) target;
                Shape value = model.expectShape(map.getValue().getTarget());
                if (value.isTimestampShape()) {
                    throw new CodegenException(target.getId() + ": maps of timestamps are not supported yet");
                }
                yield "std::collections::BTreeMap<" + base(model.expectShape(map.getKey().getTarget())) + ", " + base(value) + ">";
            }
            default -> throw new CodegenException("No Rust type for " + target.getType() + " " + target.getId());
        };
    }

    /** The serde attributes a member needs beyond its wire name: timestamps and optional members. */
    String serdeExtra(MemberShape m) {
        StringBuilder s = new StringBuilder();
        Shape target = model.expectShape(m.getTarget());
        if (target.isTimestampShape()) {
            s.append(", with = \"::caitlyn_sdk_core::time::").append(m.isRequired() ? "rfc3339" : "rfc3339_option").append('"');
        } else if (target.isBlobShape()) {
            throw new CodegenException(m.getId() + ": blobs in JSON bodies are not supported yet");
        }
        if (!m.isRequired()) {
            s.append(", skip_serializing_if = \"Option::is_none\"");
        }
        return s.toString();
    }
}
