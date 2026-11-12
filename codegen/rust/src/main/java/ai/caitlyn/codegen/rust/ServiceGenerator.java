package ai.caitlyn.codegen.rust;

import ai.caitlyn.codegen.model.CaitlynTraits;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.PaginationInfo;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.neighbor.Walker;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.pattern.SmithyPattern;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.ErrorTrait;
import software.amazon.smithy.model.traits.HttpErrorTrait;
import software.amazon.smithy.model.traits.HttpResponseCodeTrait;
import software.amazon.smithy.model.traits.RetryableTrait;
import software.amazon.smithy.model.traits.TitleTrait;

/**
 * Writes everything that is not a shape: one src/&lt;namespace&gt;.rs per namespace (Input types, operation
 * descriptors, request builders, response readers, methods, lists, streams and upload helpers), src/client.rs,
 * src/error.rs (one Error variant per modelled error shape), src/lib.rs and Cargo.toml.
 */
final class ServiceGenerator {
    private static final ShapeId WAITABLE = ShapeId.from("smithy.waiters#waitable");
    private static final Set<String> RESERVED_VARIANTS = Set.of("Api", "NotSupportedByServer", "Input", "Auth", "Connection", "Cancelled");

    private final RustContext ctx;
    private final Model model;
    private final ServiceShape service;
    private final ModelFacts facts;
    private final Map<ShapeId, OperationInfo> ops = new LinkedHashMap<>();
    private final TreeMap<String, List<OperationInfo>> byNamespace = new TreeMap<>();
    /** Every error shape in the service, by status. */
    private final TreeMap<Integer, StructureShape> errorsByStatus = new TreeMap<>();
    private final List<String> skippedWaiters = new ArrayList<>();

    ServiceGenerator(RustContext ctx, ServiceShape service) {
        this.ctx = ctx;
        this.model = ctx.model();
        this.service = service;
        this.facts = ctx.facts();
        for (OperationShape op : new TreeSet<>(TopDownIndex.of(model).getContainedOperations(service))) {
            if (CaitlynTraits.stability(op).equals("internal")) {
                continue;
            }
            OperationInfo info = new OperationInfo(model, service, op);
            ops.put(op.getId(), info);
            byNamespace.computeIfAbsent(info.namespace, k -> new ArrayList<>()).add(info);
        }
        for (Shape s : new Walker(model).walkShapes(service)) {
            if (s.hasTrait(ErrorTrait.class)) {
                int status = s.getTrait(HttpErrorTrait.class).map(HttpErrorTrait::getCode)
                        .orElseThrow(() -> new CodegenException(s.getId() + " has no @httpError"));
                StructureShape prev = errorsByStatus.put(status, s.asStructureShape().orElseThrow());
                if (prev != null && !prev.getId().equals(s.getId())) {
                    throw new CodegenException(prev.getId() + " and " + s.getId() + " share HTTP " + status + " (PROTOCOL.md lint rule 1)");
                }
            }
        }
    }

    void run() {
        for (Map.Entry<String, List<OperationInfo>> ns : byNamespace.entrySet()) {
            ctx.writerDelegator().useFileWriter("src/" + ns.getKey() + ".rs", "", w -> {
                w.l("#![allow(unused_imports, clippy::doc_lazy_continuation, clippy::field_reassign_with_default, clippy::needless_update)]\n\nuse caitlyn_sdk_core as rt;\n"
                        + "use serde::{Deserialize, Serialize};\n\nuse crate::client::*;\nuse crate::error::Error;\nuse crate::types::*;\n\n");
                for (OperationInfo op : ns.getValue()) {
                    operation(w, op);
                }
                uploadHelpers(w, ns.getValue());
            });
        }
        errors();
        client();
        lib();
        cargo();
    }

    private Shape target(MemberShape m) {
        return model.expectShape(m.getTarget());
    }

    private String fnName(OperationInfo op) {
        return Names.snake(op.name);
    }

    // ------------------------------------------------------------------ one operation

    private void operation(RustWriter w, OperationInfo op) {
        inputType(w, op);
        errorTable(w, op);
        descriptor(w, op);
        builder(w, op);
        switch (op.kind) {
            case UNARY -> {
                reader(w, op);
                unary(w, op);
            }
            case PAGINATED -> {
                reader(w, op);
                paginated(w, op);
            }
            case STREAM -> stream(w, op);
        }
        if (op.op.findTrait(WAITABLE).isPresent()) {
            // Waiters come with the waiter runtime (as K1 has); nothing in the model uses them yet.
            skippedWaiters.add(op.name);
        }
    }

    private String resultType(OperationInfo op) {
        return ctx.symbolProvider().toSymbol(op.output).getName();
    }

    private String errorsDoc(OperationInfo op) {
        List<String> parts = new ArrayList<>();
        for (StructureShape e : OperationIndex.of(model).getErrors(service, op.op)) {
            parts.add("[`Error::" + variant(e) + "`] (" + e.expectTrait(HttpErrorTrait.class).getCode() + ")");
        }
        return parts.isEmpty() ? "" : "Errors: " + String.join(", ", parts) + "; another status the API models has its own variant too ([`Error::NotFound`] for 404), and any other status is [`Error::Api`].";
    }

    private String methodDoc(OperationInfo op, String extra) {
        StringBuilder text = new StringBuilder(CaitlynRustCodegen.doc(op.op).strip());
        if (!extra.isEmpty()) {
            text.append("\n\n").append(extra);
        }
        String errs = errorsDoc(op);
        if (!errs.isEmpty()) {
            text.append("\n\n").append(errs);
        }
        op.since.ifPresent(s -> text.append("\n\nSince Caitlyn ").append(s).append(op.stability.equals("ga") ? "." : "; " + op.stability + "."));
        return Names.doc(text.toString(), "    ");
    }

    /** "conversation_id: impl Into<String>, " for an operation with a positional identifier. */
    private String positionalParam(OperationInfo op) {
        return op.positionalParam().map(p -> p + ": impl Into<String>, ").orElse("");
    }

    private void inputType(RustWriter w, OperationInfo op) {
        String name = op.inputType();
        StringBuilder text = new StringBuilder("The input of `" + op.namespace + "()." + op.method + "`.");
        op.positional.ifPresent(p -> text.append(" `").append(p.member().getMemberName()).append("` is a parameter of the method."));
        op.ifMatch.ifPresent(p -> text.append(" `If-Match` is the call option `.if_match(etag)`").append(p.member().isRequired() ? " (required)." : "."));
        op.idempotency.ifPresent(p -> text.append(" The idempotency key is generated, or set with `.idempotency_key(key)`."));
        w.l(Names.doc(text.toString(), ""));
        w.l("#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]\n#[serde(default)]\npub struct " + name + " {\n");
        for (OperationInfo.Param p : op.fields) {
            MemberShape m = p.member();
            if (p.location() == HttpBinding.Location.PAYLOAD) {
                throw new CodegenException(m.getId() + ": @httpPayload inputs are not supported yet");
            }
            StringBuilder d = new StringBuilder(CaitlynRustCodegen.memberDoc(ctx, m));
            String where = switch (p.location()) {
                case LABEL -> "Sent in the path.";
                case QUERY -> "Sent as the query parameter `" + p.wire() + "`.";
                case HEADER -> "Sent as the `" + p.wire() + "` header.";
                default -> "";
            };
            CaitlynTraits.since(m).ifPresent(s -> d.append("\n\nSince Caitlyn ").append(s).append(": refused before sending to an older server."));
            if (!where.isEmpty()) {
                d.append("\n\n").append(where);
            }
            w.l(Names.doc(d.toString(), "    "));
            if (p.location() == HttpBinding.Location.DOCUMENT) {
                w.l("    #[serde(rename = " + Names.str(p.wire()) + ctx.types().serdeExtra(m) + ")]\n");
            } else {
                w.l("    #[serde(skip)]\n");
            }
            w.l("    pub " + p.field() + ": " + ctx.types().member(m) + ",\n");
        }
        w.l("}\n\n");
    }

    /**
     * Maps runtime errors to the typed variants. The variant is the one for the HTTP status whether or not the
     * operation models it (PROTOCOL.md 6.2), so every operation uses the service-wide mapping.
     */
    private void errorTable(RustWriter w, OperationInfo op) {
        w.l("fn errors_" + fnName(op) + "(e: rt::Error) -> Error {\n    Error::from(e)\n}\n\n");
    }

    private void descriptor(RustWriter w, OperationInfo op) {
        List<String> retryable = new ArrayList<>();
        for (StructureShape e : OperationIndex.of(model).getErrors(service, op.op)) {
            if (e.hasTrait(RetryableTrait.class)) {
                retryable.add(String.valueOf(e.expectTrait(HttpErrorTrait.class).getCode()));
            }
        }
        StringBuilder d = new StringBuilder("static OP_" + Names.constant(op.name) + ": rt::Operation = rt::Operation {\n");
        d.append("    name: ").append(Names.str(op.name)).append(",\n");
        d.append("    method: ").append(Names.str(op.http.getMethod())).append(",\n");
        d.append("    since: ").append(op.since.map(s -> "Some(" + Names.str(s) + ")").orElse("None")).append(",\n");
        d.append("    retry_safe: ").append(op.retrySafe).append(",\n");
        d.append("    sse: ").append(op.kind == OperationInfo.Kind.STREAM).append(",\n");
        d.append("    idempotency_header: ").append(op.idempotency.map(p -> "Some(" + Names.str(p.wire()) + ")").orElse("None")).append(",\n");
        d.append("    if_match_required: ").append(op.ifMatch.map(p -> p.member().isRequired()).orElse(false)).append(",\n");
        d.append("    retryable: &[").append(String.join(", ", retryable)).append("],\n};\n\n");
        w.l(d.toString());
    }

    // ------------------------------------------------------------------ requests

    /** A Rust expression for a member's value in the builder: the positional parameter or input.<field>. */
    private String valueExpr(OperationInfo op, OperationInfo.Param p) {
        if (op.positional.isPresent() && op.positional.get().member().equals(p.member())) {
            return op.positionalParam().orElseThrow();
        }
        return "input." + p.field();
    }

    /** Formats a scalar of the target's type as a String. {@code v} is a reference to the value. */
    private String format(Shape target, String v, MemberShape m) {
        return switch (target.getType()) {
            case STRING -> v + ".to_string()";
            case ENUM -> v + ".as_str().to_owned()";
            case BYTE, SHORT, INTEGER, LONG, BOOLEAN -> v + ".to_string()";
            case TIMESTAMP -> "rt::time::format(" + v + ")";
            default -> throw new CodegenException(m.getId() + ": " + target.getType() + " is not supported in a label, query or header yet");
        };
    }

    private String isSet(OperationInfo op, OperationInfo.Param p) {
        if (p.member().isRequired()) {
            return "true";
        }
        return valueExpr(op, p) + ".is_some()";
    }

    private void builder(RustWriter w, OperationInfo op) {
        String in = op.inputType();
        String pos = op.positionalParam().map(p -> p + ": &str, ").orElse("");
        w.l("fn build_" + fnName(op) + "(" + pos + "input: &" + in + ") -> Result<rt::Request, rt::Error> {\n");
        if (op.fields.isEmpty()) {
            w.l("    let _ = input;\n");
        }
        // Required labels must be non-empty.
        for (OperationInfo.Param p : op.all) {
            if (p.location() == HttpBinding.Location.LABEL && target(p.member()).isStringShape()) {
                w.l("    if " + valueExpr(op, p) + ".is_empty() {\n        return Err(rt::Error::missing_input(" + Names.str(op.name) + ", "
                        + Names.str(p.member().getMemberName()) + "));\n    }\n");
            }
        }
        List<String> parts = new ArrayList<>();
        StringBuilder literal = new StringBuilder();
        for (SmithyPattern.Segment seg : op.http.getUri().getSegments()) {
            literal.append('/');
            if (seg.isLabel()) {
                if (seg.isGreedyLabel()) {
                    throw new CodegenException(op.op.getId() + ": greedy labels are not supported yet");
                }
                OperationInfo.Param p = op.param(seg.getContent()).orElseThrow();
                parts.add(Names.str(literal.toString()));
                boolean positional = op.positional.isPresent() && op.positional.get().member().equals(p.member());
                parts.add(target(p.member()).isStringShape()
                        ? "&rt::path_label(" + (positional ? "" : "&") + valueExpr(op, p) + ")"
                        : "&rt::path_label(&" + format(target(p.member()), "&" + valueExpr(op, p), p.member()) + ")");
                literal.setLength(0);
            } else {
                literal.append(seg.getContent());
            }
        }
        if (literal.length() > 0 || parts.isEmpty()) {
            parts.add(Names.str(literal.toString()));
        }
        if (op.http.getUri().getQueryLiterals().size() > 0) {
            throw new CodegenException(op.op.getId() + ": query literals in @http are not supported yet");
        }
        boolean mutated = op.fields.stream().anyMatch(p -> p.location() == HttpBinding.Location.QUERY || p.location() == HttpBinding.Location.HEADER)
                || op.all.stream().anyMatch(p -> p.location() == HttpBinding.Location.DOCUMENT) || !sinceMembers(op).isEmpty();
        w.l("    let " + (mutated ? "mut " : "") + "req = rt::Request::new([" + String.join(", ", parts) + "].concat());\n");
        for (OperationInfo.Param p : op.fields) {
            if (p.location() != HttpBinding.Location.QUERY && p.location() != HttpBinding.Location.HEADER) {
                continue;
            }
            String set = p.location() == HttpBinding.Location.QUERY ? "req.query(" : "req.header(";
            Shape t = target(p.member());
            String v = valueExpr(op, p);
            if (t instanceof ListShape list) {
                Shape item = model.expectShape(list.getMember().getTarget());
                String iter = p.member().isRequired() ? v + ".iter()" : v + ".iter().flatten()";
                w.l("    for v in " + iter + " {\n        " + set + Names.str(p.wire()) + ", " + format(item, "v", p.member()) + ");\n    }\n");
            } else if (!p.member().isRequired()) {
                w.l("    if let Some(v) = &" + v + " {\n        " + set + Names.str(p.wire()) + ", " + format(t, "v", p.member()) + ");\n    }\n");
            } else {
                w.l("    " + set + Names.str(p.wire()) + ", " + format(t, "&" + v, p.member()) + ");\n");
            }
        }
        for (OperationInfo.Param p : sinceMembers(op)) {
            w.l("    if " + isSet(op, p) + " {\n        req.since(" + Names.str(p.member().getMemberName()) + ", "
                    + Names.str(CaitlynTraits.since(p.member()).orElseThrow()) + ");\n    }\n");
        }
        if (op.all.stream().anyMatch(p -> p.location() == HttpBinding.Location.DOCUMENT)) {
            w.l("    req.json_body(input)?;\n");
        }
        w.l("    Ok(req)\n}\n\n");
    }

    /** Input members whose @since is newer than the operation's (PROTOCOL.md 9). */
    private List<OperationInfo.Param> sinceMembers(OperationInfo op) {
        List<OperationInfo.Param> out = new ArrayList<>();
        for (OperationInfo.Param p : op.fields) {
            Optional<String> since = CaitlynTraits.since(p.member());
            if (since.isPresent() && op.since.map(s -> ModelFacts.compareVersions(since.get(), s) > 0).orElse(true)) {
                out.add(p);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ responses

    private void reader(RustWriter w, OperationInfo op) {
        String result = resultType(op);
        Map<String, HttpBinding> bindings = HttpBindingIndex.of(model).getResponseBindings(op.op);
        boolean body = false;
        for (HttpBinding b : bindings.values()) {
            if (b.getLocation() == HttpBinding.Location.DOCUMENT) {
                body = true;
            } else if (b.getLocation() == HttpBinding.Location.PAYLOAD || b.getMember().hasTrait(HttpResponseCodeTrait.class)
                    || b.getLocation() == HttpBinding.Location.PREFIX_HEADERS) {
                throw new CodegenException(b.getMember().getId() + ": " + b.getLocation() + " output bindings are not supported yet");
            }
        }
        w.l("async fn read_" + fnName(op) + "(resp: rt::Response) -> Result<" + result + ", rt::Error> {\n");
        StringBuilder headers = new StringBuilder();
        for (HttpBinding b : bindings.values()) {
            if (b.getLocation() != HttpBinding.Location.HEADER) {
                continue;
            }
            MemberShape m = b.getMember();
            if (!target(m).isStringShape()) {
                throw new CodegenException(m.getId() + ": non-string response headers are not supported yet");
            }
            String field = Names.snake(m.getMemberName());
            w.l("    let " + field + " = resp.header(" + Names.str(b.getLocationName().toLowerCase(java.util.Locale.ROOT)) + ");\n");
            headers.append("    out.").append(field).append(" = ").append(field).append(m.isRequired() ? ".unwrap_or_default()" : "").append(";\n");
        }
        w.l("    let metadata = resp.metadata();\n");
        w.l(body ? "    let mut out: " + result + " = resp.json().await?;\n" : "    drop(resp);\n    let mut out = " + result + "::default();\n");
        w.l(headers.toString());
        w.l("    out.response_metadata = metadata;\n");
        w.l("    Ok(out)\n}\n\n");
    }

    /** The call's body: build, send, read, with every runtime error mapped to the operation's typed errors. */
    private String callBody(OperationInfo op, String posExpr, String tail) {
        String e = "errors_" + fnName(op);
        return "            let req = build_" + fnName(op) + "(" + posExpr + "&input).map_err(" + e + ")?;\n"
                + "            let resp = core.send(&OP_" + Names.constant(op.name) + ", req, &opts).await.map_err(" + e + ")?;\n" + tail;
    }

    private String positionalSetup(OperationInfo op) {
        return op.positionalParam().map(p -> "        let " + p + ": String = " + p + ".into();\n").orElse("");
    }

    private String posExpr(OperationInfo op) {
        return op.positionalParam().map(p -> "&" + p + ", ").orElse("");
    }

    private void unary(RustWriter w, OperationInfo op) {
        String result = resultType(op);
        w.l("impl " + op.namespaceType + " {\n");
        w.l(methodDoc(op, ""));
        w.l("    pub fn " + op.method + "(&self, " + positionalParam(op) + "input: " + op.inputType() + ") -> rt::Call<" + result + ", Error> {\n");
        w.l("        let core = self.core.clone();\n" + positionalSetup(op));
        w.l("        rt::Call::new(move |opts| Box::pin(async move {\n");
        w.l(callBody(op, posExpr(op), "            read_" + fnName(op) + "(resp).await.map_err(errors_" + fnName(op) + ")\n"));
        w.l("        }))\n    }\n}\n\n");
    }

    private void paginated(RustWriter w, OperationInfo op) {
        PaginationInfo pi = op.pagination.orElseThrow();
        if (pi.getOutputTokenMemberPath().size() != 1 || pi.getItemsMemberPath().size() != 1) {
            throw new CodegenException(op.op.getId() + ": nested pagination paths are not supported yet");
        }
        MemberShape items = pi.getItemsMemberPath().get(0);
        MemberShape next = pi.getOutputTokenMemberPath().get(0);
        String itemType = ctx.types().base(model.expectShape(((ListShape) target(items)).getMember().getTarget()));
        String page = resultType(op);
        String cursorField = Names.snake(pi.getInputTokenMember().getMemberName());
        if (pi.getInputTokenMember().isRequired() || next.isRequired()) {
            throw new CodegenException(op.op.getId() + ": required pagination tokens are not supported yet");
        }
        String itemsExpr = "p." + Names.snake(items.getMemberName()) + (items.isRequired() ? "" : ".unwrap_or_default()");
        w.l("impl " + op.namespaceType + " {\n");
        w.l(methodDoc(op, "It yields every item, fetching pages as needed (`next().await`, or `collect().await` for all of them); `"
                + op.method + "_pages` yields whole pages."));
        w.l("    pub fn " + op.method + "(&self, " + positionalParam(op) + "input: " + op.inputType() + ") -> rt::Items<" + page + ", " + itemType + ", Error> {\n");
        w.l("        rt::Items::new(self." + op.method + "_pages(" + op.positionalParam().map(p -> p + ", ").orElse("") + "input), |p| " + itemsExpr + ")\n    }\n\n");
        w.l(Names.doc("The pages of `" + op.namespace + "()." + op.method + "`, from `input." + cursorField + "` (normally unset) to the last page.", "    "));
        w.l("    pub fn " + op.method + "_pages(&self, " + positionalParam(op) + "input: " + op.inputType() + ") -> rt::Pages<" + page + ", Error> {\n");
        w.l("        let core = self.core.clone();\n" + positionalSetup(op));
        w.l("        let start = input." + cursorField + ".clone();\n");
        w.l("        rt::Pages::new(start, move |cursor, opts| {\n            let core = core.clone();\n");
        op.positionalParam().ifPresent(p -> w.l("            let " + p + " = " + p + ".clone();\n"));
        w.l("            let mut input = input.clone();\n            input." + cursorField + " = cursor;\n            Box::pin(async move {\n");
        String e = "errors_" + fnName(op);
        w.l("                let req = build_" + fnName(op) + "(" + posExpr(op) + "&input).map_err(" + e + ")?;\n"
                + "                let resp = core.send(&OP_" + Names.constant(op.name) + ", req, &opts).await.map_err(" + e + ")?;\n"
                + "                let out = read_" + fnName(op) + "(resp).await.map_err(" + e + ")?;\n"
                + "                let next = out." + Names.snake(next.getMemberName()) + ".clone();\n                Ok((out, next))\n");
        w.l("            })\n        })\n    }\n}\n\n");
    }

    // ------------------------------------------------------------------ streams

    private final Set<String> emittedFinals = new HashSet<>();
    private final Map<String, String> streamAliases = new LinkedHashMap<>();

    private record StreamTypes(String union, String finalType, String finalFn) {}

    private StreamTypes streamTypes(RustWriter w, OperationInfo op) {
        ObjectNode sse = op.sse.orElseThrow();
        UnionShape union = model.expectShape(ShapeId.from(sse.expectStringMember("events").getValue()), UnionShape.class);
        String u = Names.pascal(union.getId().getName());
        Optional<String> fin = sse.getStringMember("final").map(s -> s.getValue());
        if (fin.isEmpty()) {
            return new StreamTypes(u, "()", "None");
        }
        MemberShape fm = union.getMember(fin.get()).orElseThrow(() -> new CodegenException(op.op.getId() + ": no union member " + fin.get()));
        StructureShape ft = model.expectShape(fm.getTarget(), StructureShape.class);
        if (ft.getAllMembers().size() != 1) {
            throw new CodegenException(ft.getId() + ": the final event must have exactly one member (PROTOCOL.md lint rule 4)");
        }
        MemberShape only = ft.getAllMembers().values().iterator().next();
        String evType = ctx.symbolProvider().toSymbol(ft).getName();
        String finalType = ctx.types().member(only);
        String fn = "final_" + Names.snake(union.getId().getName()) + "_" + Names.snake(evType);
        if (emittedFinals.add(fn)) {
            w.l("fn " + fn + "(ev: &" + u + ") -> Option<" + finalType + "> {\n    match ev {\n        " + u + "::" + evType
                    + "(v) => Some(v." + Names.snake(only.getMemberName()) + ".clone()),\n        _ => None,\n    }\n}\n\n");
        }
        return new StreamTypes(u, finalType, "Some(" + fn + ")");
    }

    private void stream(RustWriter w, OperationInfo op) {
        StreamTypes st = streamTypes(w, op);
        String alias = st.union() + "Stream";
        String target = "rt::Stream<" + st.union() + ", " + st.finalType() + ", Error>";
        String prev = streamAliases.putIfAbsent(alias, target);
        if (prev == null) {
            w.l(Names.doc("A stream of [`" + st.union() + "`] events. Call `next().await` until it returns `None`, then `final_message().await`"
                    + (st.finalType().equals("()") ? "" : " for the [`" + st.finalType() + "`]")
                    + " (it drains the stream if needed). A dropped connection is resumed with `Last-Event-ID` where the model allows; "
                    + "dropping the stream closes the connection.", ""));
            w.l("pub type " + alias + " = " + target + ";\n\n");
        } else if (!prev.equals(target)) {
            throw new CodegenException(op.op.getId() + ": two streams of " + st.union() + " with different final events");
        }
        ObjectNode sse = op.sse.orElseThrow();
        String resume = "None";
        StringBuilder resumeSetup = new StringBuilder();
        Optional<String> resumeWith = sse.getStringMember("resumeWith").map(s -> s.getValue());
        if (resumeWith.isPresent()) {
            OperationInfo r = ops.get(ShapeId.from(resumeWith.get()));
            if (r == null) {
                throw new CodegenException(op.op.getId() + ": resumeWith " + resumeWith.get() + " is not a generated operation");
            }
            List<String> captured = new ArrayList<>();
            StringBuilder fill = new StringBuilder();
            String positionalArg = "";
            boolean lastSet = false;
            for (OperationInfo.Param rp : r.all) {
                String member = rp.member().getMemberName();
                if (rp.location() == HttpBinding.Location.HEADER && rp.wire().equalsIgnoreCase("Last-Event-ID")) {
                    fill.append("                        rin.").append(rp.field()).append(" = ").append(rp.member().isRequired() ? "last_event_id" : "Some(last_event_id)").append(";\n");
                    lastSet = true;
                    continue;
                }
                if (rp.location() != HttpBinding.Location.LABEL) {
                    continue;
                }
                OperationInfo.Param src = op.param(member).orElseThrow(() ->
                        new CodegenException(r.op.getId() + ": label " + member + " has no member of the same name in " + op.op.getId()));
                String local = "label_" + Names.snake(member).replace("r#", "");
                resumeSetup.append("            let ").append(local).append(" = ").append(valueExpr(op, src)).append(".clone();\n");
                captured.add(local);
                if (r.positional.isPresent() && r.positional.get().member().getMemberName().equals(member)) {
                    positionalArg = "&" + local + ", ";
                } else {
                    fill.append("                        rin.").append(rp.field()).append(" = ").append(local).append(".clone();\n");
                }
            }
            if (!lastSet) {
                throw new CodegenException(r.op.getId() + ": a resumeWith operation needs a Last-Event-ID header member");
            }
            StringBuilder b = new StringBuilder();
            b.append("            let resume_core = core.clone();\n            let resume_opts = opts.cancellation_only();\n");
            b.append("            let resume: rt::stream::Resume = Box::new(move |last_event_id: String| {\n");
            b.append("                let core = resume_core.clone();\n                let opts = resume_opts.clone();\n");
            for (String c : captured) {
                b.append("                let ").append(c).append(" = ").append(c).append(".clone();\n");
            }
            b.append("                Box::pin(async move {\n");
            b.append("                        let mut rin = ").append(r.inputType()).append("::default();\n").append(fill);
            b.append("                        let rreq = build_").append(fnName(r)).append("(").append(positionalArg).append("&rin)?;\n");
            b.append("                        core.send(&OP_").append(Names.constant(r.name)).append(", rreq, &opts).await\n");
            b.append("                })\n            });\n");
            resumeSetup.append(b);
            resume = "Some(resume)";
        }
        w.l("impl " + op.namespaceType + " {\n");
        w.l(methodDoc(op, "Awaiting the call returns the stream once the response starts, or the error for a failed request at once; "
                + "errors during the stream (a failure event, a connection that could not be resumed, cancellation) end it with that error."));
        w.l("    pub fn " + op.method + "(&self, " + positionalParam(op) + "input: " + op.inputType() + ") -> rt::Call<" + alias + ", Error> {\n");
        w.l("        let core = self.core.clone();\n" + positionalSetup(op));
        w.l("        rt::Call::new(move |opts| Box::pin(async move {\n");
        w.l(callBody(op, posExpr(op), resumeSetup + "            Ok(rt::Stream::open(resp, rt::StreamSpec {\n"
                + "                decode: decode_" + Names.snake(st.union()) + ",\n                final_of: " + st.finalFn() + ",\n"
                + "                map_err: errors_" + fnName(op) + ",\n                resume: " + resume + ",\n            }))\n"));
        w.l("        }))\n    }\n}\n\n");
    }

    // ------------------------------------------------------------------ uploads (PROTOCOL.md 10)

    private void uploadHelpers(RustWriter w, List<OperationInfo> nsOps) {
        for (OperationInfo op : nsOps) {
            if (op.op.findTrait(CaitlynTraits.PRESIGNED_UPLOAD).isPresent()) {
                for (String m : List.of("fileName", "contentType", "byteSize", "sha256")) {
                    op.param(m).orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs input member " + m));
                }
                for (String m : List.of("uploadUrl", "uploadMethod", "requiredHeaders")) {
                    op.output.getMember(m).orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs output member " + m));
                }
                if (nsOps.stream().anyMatch(o -> o.method.equals("create"))) {
                    throw new CodegenException(op.op.getId() + ": " + op.namespace + " already has create; the upload helper needs the name");
                }
                String result = resultType(op);
                String headers = op.output.getMember("requiredHeaders").orElseThrow().isRequired() ? "&up.required_headers" : "&up.required_headers.clone().unwrap_or_default()";
                w.l("impl " + op.namespaceType + " {\n");
                w.l(Names.doc("Uploads a file: it computes the SHA-256, reserves a slot with `" + op.method + "`, then sends the bytes to the "
                        + "presigned URL with exactly the required headers (no Caitlyn credentials go there). Bytes that cannot be sent "
                        + "give [`Error::Api`] with the code `UPLOAD_PUT_FAILED`.", "    "));
                w.l("    pub fn create(&self, file: rt::UploadFile) -> rt::Call<" + result + ", Error> {\n        let this = self.clone();\n");
                w.l("        rt::Call::new(move |opts| Box::pin(async move {\n");
                w.l("            let input = " + op.inputType() + " {\n                file_name: file.name.clone(),\n"
                        + "                content_type: file.content_type.clone(),\n                byte_size: file.data.len() as i64,\n"
                        + "                sha256: file.sha256(),\n                ..Default::default()\n            };\n");
                w.l("            let up = this." + op.method + "(input).options(opts.clone()).await?;\n");
                w.l("            this.core.put_presigned(&up.upload_method, &up.upload_url, " + headers + ", file.data, &opts).await.map_err(Error::from)?;\n");
                w.l("            Ok(up)\n        }))\n    }\n}\n\n");
            }
            Optional<String> target = CaitlynTraits.stringMember(op.op, CaitlynTraits.UPLOAD_TARGET, "member");
            if (target.isPresent()) {
                OperationInfo presigned = ops.values().stream().filter(o -> o.op.findTrait(CaitlynTraits.PRESIGNED_UPLOAD).isPresent())
                        .findFirst().orElseThrow(() -> new CodegenException(op.op.getId() + ": @uploadTarget needs a @presignedUpload operation"));
                OperationInfo.Param p = op.param(target.get()).orElseThrow();
                String result = resultType(op);
                w.l("impl " + op.namespaceType + " {\n");
                w.l(Names.doc("Uploads `file` (as `" + presigned.namespace + "().create` does), then calls `" + op.method + "` with `"
                        + p.field() + "` set to the upload's `id`. Other fields come from `input`.", "    "));
                w.l("    pub fn upload(&self, " + positionalParam(op) + "file: rt::UploadFile, input: " + op.inputType() + ") -> rt::Call<" + result + ", Error> {\n");
                w.l("        let this = self.clone();\n        let uploads = " + presigned.namespaceType + " { core: self.core.clone() };\n" + positionalSetup(op));
                w.l("        rt::Call::new(move |opts| Box::pin(async move {\n");
                w.l("            let up = uploads.create(file).options(opts.clone()).await?;\n");
                w.l("            let mut input = input;\n            input." + p.field() + " = " + (p.member().isRequired() ? "up.id" : "Some(up.id)") + ";\n");
                w.l("            this." + op.method + "(" + op.positionalParam().map(x -> x + ", ").orElse("") + "input).options(opts).await\n        }))\n    }\n}\n\n");
            }
        }
    }

    // ------------------------------------------------------------------ errors

    private static String variant(StructureShape e) {
        String n = Names.pascal(e.getId().getName());
        String v = n.endsWith("Error") && n.length() > 5 ? n.substring(0, n.length() - 5) : n;
        if (RESERVED_VARIANTS.contains(v)) {
            throw new CodegenException(e.getId() + ": its variant name " + v + " clashes with one the SDK uses");
        }
        return v;
    }

    private void errors() {
        ctx.writerDelegator().useFileWriter("src/error.rs", "", w -> {
            w.l("use caitlyn_sdk_core as rt;\n\n");
            w.l(Names.doc("Everything a call can fail with. A problem response is the variant for its HTTP status, whether or not the "
                    + "operation lists that error (PROTOCOL.md 6.2); any other status, and errors the SDK raises itself (`STREAM_LOST`, "
                    + "`NO_FINAL_EVENT`, `UPLOAD_PUT_FAILED`, with status 0), are [`Error::Api`]. Every problem variant carries an "
                    + "[`ApiError`](rt::ApiError) with `status`, `code` and `request_id`; [`Error::api`] reads it whichever variant it is. "
                    + "A call that got no response is [`Error::Connection`], with status 0 and code `CONNECTION_ERROR` (PROTOCOL.md 6.5).", ""));
            w.l("#[derive(Debug)]\n#[non_exhaustive]\npub enum Error {\n");
            for (StructureShape e : errorsByStatus.values()) {
                int status = e.expectTrait(HttpErrorTrait.class).getCode();
                String text = CaitlynRustCodegen.doc(e);
                w.l(Names.doc("HTTP " + status + " (`" + e.getId().getName() + "` in the model)." + (text.isEmpty() ? "" : " " + text), "    "));
                w.l("    " + variant(e) + "(Box<rt::ApiError>),\n");
            }
            w.l("    /// Any other status, or an error the SDK raised itself (status 0).\n    Api(Box<rt::ApiError>),\n"
                    + "    /// An operation, or a member you set, is newer than the server. Nothing was sent.\n    NotSupportedByServer(rt::NotSupportedByServer),\n"
                    + "    /// A required input is missing. Nothing was sent.\n    Input(rt::InputError),\n"
                    + "    /// Signing in failed.\n    Auth(rt::AuthError),\n"
                    + "    /// No response arrived, or the connection failed while the body was read, after any retries: status 0,\n"
                    + "    /// code `CONNECTION_ERROR`, and the network error as its source.\n    Connection(rt::ConnectionError),\n"
                    + "    /// The call's cancellation token fired.\n    Cancelled,\n}\n\n");
            StringBuilder api = new StringBuilder();
            StringBuilder shape = new StringBuilder();
            StringBuilder from = new StringBuilder();
            for (Map.Entry<Integer, StructureShape> e : errorsByStatus.entrySet()) {
                String v = variant(e.getValue());
                api.append("            Error::").append(v).append("(e) => Some(e),\n");
                shape.append("            Error::").append(v).append("(_) => Some(").append(Names.str(e.getValue().getId().getName())).append("),\n");
                from.append("                    ").append(e.getKey()).append(" => Error::").append(v).append("(a),\n");
            }
            w.l("impl Error {\n");
            w.l("    /// The problem details, for every problem variant.\n    pub fn api(&self) -> Option<&rt::ApiError> {\n        match self {\n"
                    + api + "            Error::Api(e) => Some(e),\n            _ => None,\n        }\n    }\n\n");
            w.l("    /// The HTTP status of a problem; 0 for a connection error or a problem the SDK raised.\n"
                    + "    pub fn status(&self) -> Option<u16> {\n        match self {\n            Error::Connection(e) => Some(e.status()),\n"
                    + "            other => other.api().map(|e| e.status),\n        }\n    }\n\n");
            w.l("    /// The stable product code of a problem, for example `NOT_FOUND`, or `CONNECTION_ERROR`.\n"
                    + "    pub fn code(&self) -> Option<&str> {\n        match self {\n            Error::Connection(e) => Some(e.code()),\n"
                    + "            other => other.api().map(|e| e.code.as_str()),\n        }\n    }\n\n");
            w.l("    /// The request's identifier; quote it to support.\n    pub fn request_id(&self) -> Option<&str> {\n"
                    + "        self.api().and_then(|e| e.request_id.as_deref())\n    }\n\n");
            w.l("    /// The model's name for the error shape, for example `NotFoundError`.\n    pub fn shape(&self) -> Option<&'static str> {\n"
                    + "        match self {\n" + shape + "            _ => None,\n        }\n    }\n\n");
            w.l("    /// Maps a runtime error to its typed variant, among `statuses` (an operation's modelled errors).\n"
                    + "    pub(crate) fn from_core(e: rt::Error, statuses: &[u16]) -> Self {\n        match e {\n"
                    + "            rt::Error::Api(a) if statuses.contains(&a.status) => match a.status {\n" + from
                    + "                _ => Error::Api(a),\n            },\n            rt::Error::Api(a) => Error::Api(a),\n"
                    + "            rt::Error::NotSupportedByServer(e) => Error::NotSupportedByServer(e),\n"
                    + "            rt::Error::Input(e) => Error::Input(e),\n            rt::Error::Auth(e) => Error::Auth(e),\n"
                    + "            rt::Error::Connection(e) => Error::Connection(e),\n            _ => Error::Cancelled,\n        }\n    }\n}\n\n");
            List<String> all = new ArrayList<>();
            errorsByStatus.keySet().forEach(s -> all.add(String.valueOf(s)));
            w.l("impl From<rt::Error> for Error {\n    fn from(e: rt::Error) -> Self {\n        Error::from_core(e, &[" + String.join(", ", all) + "])\n    }\n}\n\n");
            StringBuilder shapes = new StringBuilder();
            errorsByStatus.forEach((st, e) -> shapes.append("    (").append(st).append(", ").append(Names.str(e.getId().getName())).append("),\n"));
            w.l("/// Every error shape in the model, by HTTP status: the class name telemetry reports as `error.type`.\n"
                    + "pub(crate) const ERROR_SHAPES: &[(u16, &str)] = &[\n" + shapes + "];\n\n");
            w.l("impl std::fmt::Display for Error {\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n"
                    + "        match self {\n            Error::NotSupportedByServer(e) => e.fmt(f),\n            Error::Input(e) => e.fmt(f),\n"
                    + "            Error::Auth(e) => e.fmt(f),\n            Error::Connection(e) => e.fmt(f),\n"
                    + "            Error::Cancelled => f.write_str(\"caitlyn: the call was cancelled\"),\n"
                    + "            other => other.api().expect(\"a problem variant\").fmt(f),\n        }\n    }\n}\n\n");
            w.l("impl std::error::Error for Error {\n    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {\n        match self {\n"
                    + "            Error::Connection(e) => Some(e),\n            other => other.api().and_then(|e| e.source.as_deref()).map(|s| s as _),\n"
                    + "        }\n    }\n}\n");
        });
    }

    // ------------------------------------------------------------------ client, lib, Cargo.toml

    private String title() {
        return service.getTrait(TitleTrait.class).map(TitleTrait::getValue).orElse("Caitlyn API");
    }

    private void client() {
        ctx.writerDelegator().useFileWriter("src/client.rs", "", w -> {
            w.l("use std::time::Duration;\n\nuse caitlyn_sdk_core as rt;\n\nuse crate::error::Error;\n\n");
            String first = byNamespace.firstKey();
            w.l(Names.doc("The " + title() + " client. Create one with [`Client::new`] or [`Client::builder`] and share it: clones are cheap "
                    + "and share the token cache. Operations are grouped by resource, for example `client." + first + "()."
                    + byNamespace.firstEntry().getValue().get(0).method + "(…)`.", ""));
            w.l("#[derive(Clone, Debug)]\npub struct Client {\n    pub(crate) core: rt::Client,\n}\n\n");
            w.l("impl Client {\n");
            w.l(Names.doc("A client for `workspace` (for example `your-company.getcaitlyn.ai`), signed in with `auth` (for example "
                    + "`Auth::token(\"cait-pat-…\")`). Nothing is read from the environment.", "    "));
            w.l("    pub fn new(workspace: impl Into<String>, auth: impl Into<rt::Auth>) -> Result<Self, Error> {\n        Self::builder(workspace, auth).build()\n    }\n\n");
            w.l("    /// A builder, to set the endpoint, the HTTP client, retries, the app ID or telemetry.\n");
            w.l("    pub fn builder(workspace: impl Into<String>, auth: impl Into<rt::Auth>) -> ClientBuilder {\n"
                    + "        ClientBuilder(rt::ClientBuilder::new(\n            rt::SdkInfo { version: crate::SDK_VERSION, model_version: crate::MODEL_VERSION, error_shapes: crate::error::ERROR_SHAPES },\n"
                    + "            workspace,\n            auth.into(),\n        ))\n    }\n\n");
            w.l("    /// The workspace hostname.\n    pub fn workspace(&self) -> &str {\n        self.core.workspace()\n    }\n\n");
            w.l("    /// The base URL requests are sent to: `https://<workspace>/api`, or the `endpoint` override.\n"
                    + "    pub fn endpoint(&self) -> &str {\n        self.core.endpoint()\n    }\n\n");
            w.l("    /// Sign-in: the current token, and the `oauth` mode's sign-in steps.\n    pub fn auth(&self) -> &rt::AuthSession {\n        self.core.auth()\n    }\n\n");
            w.l("    /// The latest `Caitlyn-Api-Version` the client has seen, or `None` before any response.\n"
                    + "    pub fn server_version(&self) -> Option<String> {\n        self.core.server_version()\n    }\n");
            for (Map.Entry<String, List<OperationInfo>> e : byNamespace.entrySet()) {
                String type = e.getValue().get(0).namespaceType;
                w.l("\n    /// The " + e.getKey() + " operations.\n    pub fn " + e.getKey() + "(&self) -> " + type + " {\n        " + type
                        + " { core: self.core.clone() }\n    }\n");
            }
            w.l("}\n\n");
            w.l("/// Builds a [`Client`].\npub struct ClientBuilder(rt::ClientBuilder);\n\nimpl ClientBuilder {\n");
            w.l("    /// Sends requests (and token requests) to `endpoint` instead of `https://<workspace>/api`. It never changes the token audience.\n"
                    + "    pub fn endpoint(self, endpoint: impl Into<String>) -> Self {\n        ClientBuilder(self.0.endpoint(endpoint))\n    }\n\n");
            w.l("    /// Replaces the HTTP client.\n    pub fn http_client(self, client: rt::reqwest::Client) -> Self {\n        ClientBuilder(self.0.http_client(client))\n    }\n\n");
            w.l("    /// Attempts for a retry-safe operation, the first included (default 3).\n"
                    + "    pub fn max_attempts(self, n: u32) -> Self {\n        ClientBuilder(self.0.max_attempts(n))\n    }\n\n");
            w.l("    /// The longest `Retry-After` the client waits for (default 60 s); a longer one fails at once.\n"
                    + "    pub fn max_retry_delay(self, d: Duration) -> Self {\n        ClientBuilder(self.0.max_retry_delay(d))\n    }\n\n");
            w.l("    /// The size of the client's retry budget, in tokens (default 500). A retry costs 5, or 10 after an attempt that\n"
                    + "    /// got no response; a call that succeeds gives back 1, or its last retry's cost. When the budget cannot pay\n"
                    + "    /// for a retry, the call fails at once with its error. 0 turns retries off.\n"
                    + "    pub fn retry_budget(self, tokens: u32) -> Self {\n        ClientBuilder(self.0.retry_budget(tokens))\n    }\n\n");
            w.l("    /// Adds `app/<id>` to the user agent.\n    pub fn app_id(self, id: impl Into<String>) -> Self {\n        ClientBuilder(self.0.app_id(id))\n    }\n\n");
            w.l("    /// Writes trace context into each attempt's headers (see [`Propagator`](rt::Propagator)).\n"
                    + "    pub fn propagator(self, p: impl rt::Propagator + 'static) -> Self {\n        ClientBuilder(self.0.propagator(p))\n    }\n\n");
            w.l("    pub fn build(self) -> Result<Client, Error> {\n        Ok(Client { core: self.0.build()? })\n    }\n}\n");
            for (Map.Entry<String, List<OperationInfo>> e : byNamespace.entrySet()) {
                List<String> methods = new ArrayList<>();
                for (OperationInfo o : e.getValue()) {
                    methods.add("`" + o.method + "`");
                }
                String type = e.getValue().get(0).namespaceType;
                w.l("\n/// The " + e.getKey() + " operations (" + String.join(", ", methods) + "). Get one with `client." + e.getKey() + "()`.\n");
                w.l("#[derive(Clone, Debug)]\npub struct " + type + " {\n    pub(crate) core: rt::Client,\n}\n");
            }
        });
    }

    private void lib() {
        RustSettings s = ctx.settings();
        StringBuilder out = new StringBuilder(RustWriter.HEADER);
        out.append(Names.innerDoc("The Rust SDK for the " + title() + ", generated from its Smithy model by caitlyn-rust-codegen, on the "
                + "hand-written runtime `" + s.coreCrate() + "`. Async on tokio, TLS through rustls, telemetry through `tracing`; it "
                + "reads no AWS configuration.\n\n"
                + "```no_run\n# async fn run() -> Result<(), caitlyn_sdk::Error> {\nuse caitlyn_sdk::{Auth, Client};\n\n"
                + "let client = Client::new(\"your-company.getcaitlyn.ai\", Auth::token(\"cait-pat-…\"))?;\n"
                + exampleCall()
                + "# Ok(())\n# }\n```"));
        out.append("#![forbid(unsafe_code)]\n\n");
        out.append("mod client;\nmod error;\n");
        for (String ns : byNamespace.keySet()) {
            out.append("mod ").append(ns).append(";\n");
        }
        out.append("pub mod types;\n\n");
        out.append("pub use client::*;\npub use error::Error;\npub use types::*;\n");
        for (String ns : byNamespace.keySet()) {
            out.append("pub use ").append(ns).append("::*;\n");
        }
        out.append("\npub use caitlyn_sdk_core::{\n    ApiError, Auth, AuthError, AuthSession, AuthorizationUrl, AwsCredentialProvider, AwsCredentials, Call, CallOptions,\n"
                + "    Callback, CancellationToken, ConnectionError, FieldError, InputError, Items, MemoryTokenStore, NotSupportedByServer,\n"
                + "    OAuthTokens, Pages, Propagator, Raw, ResponseMetadata, SigningAlgorithm, Stream, TokenStore, UploadFile,\n};\n\n");
        out.append("/// The sign-in modes' option types.\npub mod auth {\n    pub use caitlyn_sdk_core::auth::*;\n    pub use caitlyn_sdk_core::aws::ProviderFn;\n}\n\n");
        out.append("/// This SDK's version.\npub const SDK_VERSION: &str = ").append(Names.str(s.version())).append(";\n\n");
        out.append("/// The Caitlyn release the SDK was generated from (the highest `@since` in the model), sent as `Caitlyn-Sdk-Model`.\n");
        out.append("pub const MODEL_VERSION: &str = ").append(Names.str(facts.apiVersion)).append(";\n");
        if (!skippedWaiters.isEmpty()) {
            out.append("\n// Waiters are not generated yet: ").append(String.join(", ", skippedWaiters)).append(".\n");
        }
        ctx.fileManifest().writeFile("src/lib.rs", out.toString());
    }

    /** One line of the crate example: the first unary operation that takes only an input. */
    private String exampleCall() {
        for (OperationInfo op : ops.values()) {
            if (op.kind == OperationInfo.Kind.UNARY && op.positional.isEmpty()) {
                return "let out = client." + op.namespace + "()." + op.method + "(caitlyn_sdk::" + op.inputType() + " {\n    ..Default::default()\n}).await?;\n"
                        + "println!(\"{:?}\", out);\n";
            }
        }
        return "";
    }

    private void cargo() {
        RustSettings s = ctx.settings();
        String core = s.corePath().isEmpty()
                ? Names.str(s.coreVersion())
                : "{ version = " + Names.str(s.coreVersion()) + ", path = " + Names.str(s.corePath()) + " }";
        String toml = "# Code generated by caitlyn-rust-codegen from the Caitlyn Smithy model. DO NOT EDIT.\n"
                + "[package]\nname = " + Names.str(s.crateName()) + "\nversion = " + Names.str(s.version()) + "\nedition = \"2021\"\n"
                + "description = " + Names.str("The Rust SDK for the " + title() + ", generated from its Smithy model.") + "\n"
                + "license = \"Apache-2.0\"\nauthors = [\"Custom D Ltd\"]\nrepository = " + Names.str(s.repository()) + "\n"
                + "homepage = \"https://build.caitlyn.ai/\"\nkeywords = [\"caitlyn\", \"sdk\", \"api\", \"ai\", \"agents\"]\n"
                + "categories = [\"api-bindings\", \"web-programming::http-client\"]\n\n"
                + "[dependencies]\n" + s.coreCrate() + " = " + core + "\n"
                + "serde = { version = \"1\", features = [\"derive\"] }\nserde_json = \"1\"\n"
                + "chrono = { version = \"0.4\", default-features = false, features = [\"std\", \"serde\"] }\n";
        ctx.fileManifest().writeFile("Cargo.toml", toml);
    }
}
