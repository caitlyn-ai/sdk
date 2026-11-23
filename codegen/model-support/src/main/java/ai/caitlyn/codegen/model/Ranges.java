package ai.caitlyn.codegen.model;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MapShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.HttpLabelTrait;
import software.amazon.smithy.model.traits.HttpPayloadTrait;
import software.amazon.smithy.model.traits.HttpQueryTrait;
import software.amazon.smithy.model.traits.JsonNameTrait;
import software.amazon.smithy.model.traits.RangeTrait;

/**
 * The {@code @range} rules a request can carry (PROTOCOL.md 3), the same in every generator: each SDK refuses a
 * value outside its range before sending, as the server would refuse it. A rule names where the value is on the
 * wire, as the server's field errors do: a query parameter by name, or a body value by a JSON Pointer (RFC 6901)
 * pattern in which {@code *} stands for any list item or map value ({@code /configuration/knowledgeBases/*\/maxQueries}).
 * A range is the member's own or, failing that, its target's. Header and label members carry none today; a range on
 * one fails generation, so it cannot be skipped unnoticed.
 */
public final class Ranges {
    /** Where a value is: {@code query} (by parameter name) or {@code body} (by pointer pattern). */
    public record Rule(String where, String path, Optional<BigDecimal> min, Optional<BigDecimal> max) {}

    private Ranges() {}

    /** Every operation's rules, by operation name, in model order; an operation with none is left out. */
    public static Map<String, List<Rule>> of(Model model, ShapeId service) {
        Map<String, List<Rule>> out = new LinkedHashMap<>();
        ServiceShape svc = model.expectShape(service, ServiceShape.class);
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(svc)) {
            List<Rule> rules = new ArrayList<>();
            Shape input = model.expectShape(op.getInputShape());
            for (MemberShape m : input.getAllMembers().values()) {
                Optional<RangeTrait> range = range(model, m);
                if (m.hasTrait(HttpQueryTrait.class)) {
                    range.ifPresent(r -> rules.add(rule("query", m.expectTrait(HttpQueryTrait.class).getValue(), r)));
                } else if (m.hasTrait(HttpHeaderTrait.class) || m.hasTrait(HttpLabelTrait.class)) {
                    if (range.isPresent()) {
                        throw new IllegalStateException(m.getId() + ": a @range on a header or label member is not checked by the SDKs yet");
                    }
                } else if (m.hasTrait(HttpPayloadTrait.class)) {
                    walk(model, model.expectShape(m.getTarget()), "", new HashSet<>(), rules);
                } else {
                    String path = "/" + wire(m);
                    range.ifPresent(r -> rules.add(rule("body", path, r)));
                    walk(model, model.expectShape(m.getTarget()), path, new HashSet<>(), rules);
                }
            }
            if (!rules.isEmpty()) out.put(op.getId().getName(), rules);
        }
        return out;
    }

    private static void walk(Model model, Shape shape, String path, Set<ShapeId> seen, List<Rule> rules) {
        if (shape.isStructureShape() || shape.isUnionShape()) {
            if (!seen.add(shape.getId())) return; // a recursive shape: its rules are already on the way down
            for (MemberShape m : shape.getAllMembers().values()) {
                String at = path + "/" + wire(m);
                range(model, m).ifPresent(r -> rules.add(rule("body", at, r)));
                walk(model, model.expectShape(m.getTarget()), at, seen, rules);
            }
            seen.remove(shape.getId());
        } else if (shape instanceof ListShape list) {
            range(model, list.getMember()).ifPresent(r -> rules.add(rule("body", path + "/*", r)));
            walk(model, model.expectShape(list.getMember().getTarget()), path + "/*", seen, rules);
        } else if (shape instanceof MapShape map) {
            range(model, map.getValue()).ifPresent(r -> rules.add(rule("body", path + "/*", r)));
            walk(model, model.expectShape(map.getValue().getTarget()), path + "/*", seen, rules);
        }
    }

    private static Optional<RangeTrait> range(Model model, MemberShape m) {
        return m.getTrait(RangeTrait.class).or(() -> model.expectShape(m.getTarget()).getTrait(RangeTrait.class));
    }

    private static String wire(MemberShape m) {
        return m.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(m.getMemberName());
    }

    private static Rule rule(String where, String path, RangeTrait r) {
        return new Rule(where, path, r.getMin(), r.getMax());
    }

    /** A bound as the SDKs write it: a plain number, no exponent, no trailing zeros. */
    public static String number(BigDecimal n) {
        BigDecimal s = n.stripTrailingZeros();
        return (s.scale() < 0 ? s.setScale(0) : s).toPlainString();
    }
}
