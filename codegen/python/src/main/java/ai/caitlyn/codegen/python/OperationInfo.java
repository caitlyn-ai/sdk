package ai.caitlyn.codegen.python;

import ai.caitlyn.codegen.model.CaitlynTraits;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.PaginatedIndex;
import software.amazon.smithy.model.knowledge.PaginationInfo;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpTrait;
import software.amazon.smithy.model.traits.IdempotencyTokenTrait;
import software.amazon.smithy.model.traits.IdempotentTrait;
import software.amazon.smithy.model.traits.JsonNameTrait;
import software.amazon.smithy.model.traits.ReadonlyTrait;

/** One operation as the Python client sees it: its HTTP bindings and how it is called. Where its method lives is the scope tree's. */
final class OperationInfo {
    enum Kind { UNARY, PAGINATED, STREAM }

    /** An input member with its HTTP binding and Python parameter name. */
    record Param(MemberShape member, HttpBinding binding, String name, boolean greedy) {
        String location() {
            return switch (binding.getLocation()) {
                case LABEL -> greedy ? "greedy_label" : "label";
                case QUERY -> "query";
                case HEADER -> "header";
                case PAYLOAD -> "payload";
                case DOCUMENT -> "body";
                default -> throw new CodegenException("Unsupported binding " + binding.getLocation() + " on " + member.getId());
            };
        }

        String wire() {
            if (binding.getLocation() == HttpBinding.Location.DOCUMENT) {
                return member.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(member.getMemberName());
            }
            return binding.getLocationName();
        }
    }

    final OperationShape op;
    final String name;
    final String constant;
    final Kind kind;
    final HttpTrait http;
    final StructureShape input;
    final StructureShape output;
    final List<Param> params = new ArrayList<>();
    final Optional<PaginationInfo> pagination;
    final Optional<ObjectNode> sse;
    final boolean retrySafe;
    final String stability;
    final Optional<String> since;

    OperationInfo(Model model, ServiceShape service, OperationShape op, PythonSettings settings) {
        this.op = op;
        this.name = op.getId().getName();
        this.constant = Names.upperSnake(name);
        OperationIndex ops = OperationIndex.of(model);
        this.input = ops.expectInputShape(op);
        this.output = ops.expectOutputShape(op);
        this.http = op.expectTrait(HttpTrait.class);
        this.pagination = PaginatedIndex.of(model).getPaginationInfo(service, op);
        this.sse = CaitlynTraits.object(op, CaitlynTraits.SSE_EVENTS);
        this.kind = sse.isPresent() ? Kind.STREAM : pagination.isPresent() ? Kind.PAGINATED : Kind.UNARY;
        this.stability = CaitlynTraits.stability(op);
        this.since = CaitlynTraits.since(op);

        Map<String, HttpBinding> bindings = HttpBindingIndex.of(model).getRequestBindings(op);
        List<String> labelOrder = http.getUri().getLabels().stream().map(l -> l.getContent()).toList();
        for (MemberShape m : input.getAllMembers().values()) {
            HttpBinding b = bindings.get(m.getMemberName());
            boolean greedy = http.getUri().getLabel(m.getMemberName()).map(l -> l.isGreedyLabel()).orElse(false);
            params.add(new Param(m, b, Names.member(m.getMemberName()), greedy));
        }
        params.sort(Comparator.comparingInt((Param p) -> {
            if (p.binding.getLocation() == HttpBinding.Location.LABEL) {
                return labelOrder.indexOf(p.member.getMemberName());
            }
            return p.member.isRequired() ? 1000 : 2000;
        }));
        this.retrySafe = op.hasTrait(ReadonlyTrait.class) || op.hasTrait(IdempotentTrait.class)
                || input.getAllMembers().values().stream().anyMatch(m -> m.hasTrait(IdempotencyTokenTrait.class));
    }

    List<Param> labels() {
        return params.stream().filter(p -> p.binding.getLocation() == HttpBinding.Location.LABEL).toList();
    }

    Optional<Param> param(String memberName) {
        return params.stream().filter(p -> p.member.getMemberName().equals(memberName)).findFirst();
    }
}
