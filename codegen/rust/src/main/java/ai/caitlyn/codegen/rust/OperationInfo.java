package ai.caitlyn.codegen.rust;

import ai.caitlyn.codegen.model.CaitlynTraits;
import ai.caitlyn.codegen.model.ClientMethod;

import java.util.ArrayList;
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
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpTrait;
import software.amazon.smithy.model.traits.IdempotencyTokenTrait;
import software.amazon.smithy.model.traits.IdempotentTrait;
import software.amazon.smithy.model.traits.ReadonlyTrait;

/** One operation as the Rust client sees it: its namespace, method, parameters and call options (PROTOCOL.md 10). */
final class OperationInfo {
    enum Kind { UNARY, PAGINATED, STREAM }

    /** An input member with its HTTP binding and Rust field name. */
    record Param(MemberShape member, HttpBinding binding, String field) {
        HttpBinding.Location location() {
            return binding.getLocation();
        }

        String wire() {
            return location() == HttpBinding.Location.DOCUMENT ? ModelFacts.wireName(member) : binding.getLocationName();
        }
    }

    final OperationShape op;
    final String name;
    /** The accessor on Client, for example documents; and its type, DocumentsClient. */
    final String namespace;
    final String namespaceType;
    /** The method name, for example list or update_draft. */
    final String method;
    final Kind kind;
    final HttpTrait http;
    final StructureShape input;
    final StructureShape output;
    /** Input members that stay fields of the Input type, in model order. */
    final List<Param> fields = new ArrayList<>();
    final List<Param> all = new ArrayList<>();
    final Optional<PaginationInfo> pagination;
    final Optional<ObjectNode> sse;
    final boolean retrySafe;
    /** The identifier passed positionally (conversations().send(conversation_id, input)), if any. */
    final Optional<Param> positional;
    /** The @idempotencyToken member (a call option, not a field), if any. */
    final Optional<Param> idempotency;
    /** The If-Match header member (a call option, not a field), if any. */
    final Optional<Param> ifMatch;
    final String stability;
    final Optional<String> since;

    OperationInfo(Model model, ServiceShape service, OperationShape op) {
        this.op = op;
        this.name = op.getId().getName();
        OperationIndex ops = OperationIndex.of(model);
        this.input = ops.expectInputShape(op);
        this.output = ops.expectOutputShape(op);
        this.http = op.expectTrait(HttpTrait.class);
        this.pagination = PaginatedIndex.of(model).getPaginationInfo(service, op);
        this.sse = CaitlynTraits.object(op, CaitlynTraits.SSE_EVENTS);
        this.kind = sse.isPresent() ? Kind.STREAM : pagination.isPresent() ? Kind.PAGINATED : Kind.UNARY;
        this.stability = CaitlynTraits.stability(op);
        this.since = CaitlynTraits.since(op);

        // Naming, shared with the TypeScript and Python generators (model-support's ClientMethod).
        ClientMethod cm = ClientMethod.of(model, op);
        String positionalMember = cm.positionalMember().orElse(null);
        this.namespace = Names.snake(cm.namespace());
        this.namespaceType = Names.pascal(cm.namespace()) + "Client";
        this.method = Names.snake(cm.method());

        Map<String, HttpBinding> bindings = HttpBindingIndex.of(model).getRequestBindings(op);
        Param pos = null;
        Param idem = null;
        Param match = null;
        for (MemberShape m : input.getAllMembers().values()) {
            HttpBinding b = bindings.get(m.getMemberName());
            Param p = new Param(m, b, Names.snake(m.getMemberName()));
            all.add(p);
            if (m.getMemberName().equals(positionalMember)) {
                pos = p;
            } else if (m.hasTrait(IdempotencyTokenTrait.class)) {
                idem = p;
            } else if (b.getLocation() == HttpBinding.Location.HEADER && b.getLocationName().equalsIgnoreCase("If-Match")) {
                match = p;
            } else {
                fields.add(p);
            }
        }
        this.positional = Optional.ofNullable(pos);
        this.idempotency = Optional.ofNullable(idem);
        this.ifMatch = Optional.ofNullable(match);
        if (idem != null && idem.location() != HttpBinding.Location.HEADER) {
            throw new CodegenException(op.getId() + ": an @idempotencyToken outside a header is not supported yet");
        }
        this.retrySafe = op.hasTrait(ReadonlyTrait.class) || op.hasTrait(IdempotentTrait.class) || idem != null;
    }

    String inputType() {
        return name + "Input";
    }

    /** The positional identifier, as a Rust parameter name. */
    Optional<String> positionalParam() {
        return positional.map(p -> Names.snake(p.member().getMemberName()));
    }

    Optional<Param> param(String memberName) {
        return all.stream().filter(p -> p.member().getMemberName().equals(memberName)).findFirst();
    }

    boolean hasBody() {
        return all.stream().anyMatch(p -> p.location() == HttpBinding.Location.DOCUMENT || p.location() == HttpBinding.Location.PAYLOAD);
    }
}
