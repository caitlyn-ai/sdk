package ai.caitlyn.codegen.rust;

import ai.caitlyn.codegen.model.CaitlynTraits;
import ai.caitlyn.codegen.model.ScopeTree;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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
 * Writes everything that is not a shape: src/operations.rs (each operation's Input type, descriptor, request builder
 * and response reader), src/client.rs (the client as scopes, {@link ScopeWriter}), src/error.rs (one Error variant
 * per modelled error shape), src/lib.rs and Cargo.toml.
 */
final class ServiceGenerator {
    private static final Set<String> RESERVED_VARIANTS = Set.of("Api", "NotSupportedByServer", "Input", "Auth", "Connection", "Cancelled", "Timeout", "SyncCancelled", "SyncDeclined");
    final RustContext ctx;
    final Model model;
    final ServiceShape service;
    final ModelFacts facts;
    final ScopeTree tree;
    final Map<ShapeId, OperationInfo> ops = new LinkedHashMap<>();
    /** Every error shape in the service, by status. */
    final TreeMap<Integer, StructureShape> errorsByStatus = new TreeMap<>();
    /** Where each operation is offered: every method of the tree, estimates included. */
    final Map<ShapeId, List<Placed>> placements = new LinkedHashMap<>();
    final ScopeWriter scopes;

    /** One method of the tree on its node; {@code job} is the method an estimate sits beside. */
    record Placed(ScopeTree.Node node, ScopeTree.Method method, Optional<ScopeTree.Method> job) {}

    ServiceGenerator(RustContext ctx, ServiceShape service) {
        this.ctx = ctx;
        this.model = ctx.model();
        this.service = service;
        this.facts = ctx.facts();
        for (OperationShape op : new TreeSet<>(TopDownIndex.of(model).getContainedOperations(service))) {
            if (CaitlynTraits.stability(op).equals("internal")) {
                continue;
            }
            ops.put(op.getId(), new OperationInfo(model, service, op));
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
        this.tree = ScopeTree.of(model, service);
        for (ScopeTree.Node n : tree.root.walk()) {
            for (ScopeTree.Method m : n.methods) {
                placements.computeIfAbsent(m.operation.getId(), k -> new ArrayList<>()).add(new Placed(n, m, Optional.empty()));
                m.estimate.ifPresent(e -> placements.computeIfAbsent(e.operation.getId(), k -> new ArrayList<>())
                        .add(new Placed(n, e, Optional.of(m))));
            }
        }
        for (ShapeId id : ops.keySet()) {
            if (!placements.containsKey(id)) {
                throw new CodegenException(id + " has no place in the scope tree");
            }
        }
        this.scopes = new ScopeWriter(this);
    }

    void run() {
        ctx.writerDelegator().useFileWriter("src/operations.rs", "", w -> {
            w.l("#![allow(unused_imports, unused_mut, clippy::type_complexity, clippy::doc_lazy_continuation, clippy::field_reassign_with_default, clippy::needless_update)]\n\n"
                    + "use caitlyn_sdk_core as rt;\nuse serde::{Deserialize, Serialize};\n\nuse crate::error::Error;\nuse crate::types::*;\n\n");
            for (OperationInfo op : ops.values()) {
                operation(w, op);
            }
            readersShorthand(w);
            processing(w);
        });
        scopes.run();
        errors();
        lib();
        cargo();
    }

    Shape target(MemberShape m) {
        return model.expectShape(m.getTarget());
    }

    String fnName(OperationInfo op) {
        return Names.snake(op.name);
    }

    String requestType(OperationInfo op) {
        return op.name + "Request";
    }

    String resultType(OperationInfo op) {
        MemberShape payload = facts.payloads.get(op.output.getId());
        return ctx.symbolProvider().toSymbol(payload != null ? model.expectShape(payload.getTarget()) : op.output).getName();
    }

    /** The @httpPayload member when the call returns a thing (PROTOCOL.md 4.2). */
    Optional<MemberShape> payload(OperationInfo op) {
        return Optional.ofNullable(facts.payloads.get(op.output.getId()));
    }

    OperationInfo info(ShapeId id) {
        return ops.get(id);
    }

    Optional<OperationInfo> byName(String name) {
        return ops.values().stream().filter(o -> o.name.equals(name)).findFirst();
    }

    // ------------------------------------------------------------------ one operation

    private void operation(RustWriter w, OperationInfo op) {
        inputType(w, op);
        descriptor(w, op);
        buildFn(w, op);
        if (op.kind != OperationInfo.Kind.STREAM) {
            reader(w, op);
        }
        request(w, op);
    }

    private String errorsDoc(OperationInfo op) {
        List<String> parts = new ArrayList<>();
        for (StructureShape e : OperationIndex.of(model).getErrors(service, op.op)) {
            parts.add("[`Error::" + variant(e) + "`] (" + e.expectTrait(HttpErrorTrait.class).getCode() + ")");
        }
        return parts.isEmpty() ? "" : "Errors: " + String.join(", ", parts) + "; another status the API models has its own variant too ([`Error::NotFound`] for 404), and any other status is [`Error::Api`].";
    }

    String methodDoc(OperationInfo op, String extra, String indent) {
        StringBuilder text = new StringBuilder(CaitlynRustCodegen.doc(op.op).strip());
        if (!extra.isEmpty()) {
            text.append("\n\n").append(extra);
        }
        String errs = errorsDoc(op);
        if (!errs.isEmpty()) {
            text.append("\n\n").append(errs);
        }
        op.since.ifPresent(s -> text.append("\n\nSince Caitlyn ").append(s).append(op.stability.equals("ga") ? "." : "; " + op.stability + "."));
        return Names.doc(text.toString(), indent);
    }

    private void inputType(RustWriter w, OperationInfo op) {
        String name = op.inputType();
        StringBuilder text = new StringBuilder("The input of " + op.name + ". The scope a call is made on fills its identifiers; [`"
                + requestType(op) + "`] sets the rest.");
        op.ifMatch.ifPresent(p -> text.append(" `If-Match` is the call option `.if_match(etag)`").append(p.member().isRequired()
                ? " (required: without it the request fails before anything is sent)."
                : " (optional: without it nothing is checked; with it, a change since that read fails with 412)."));
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
            facts.uploads.fileField(op.input.getId(), m.getMemberName()).ifPresent(f -> w.l(CaitlynRustCodegen.fileField(p.field(), f)));
        }
        w.l("}\n\n");
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

    // ------------------------------------------------------------------ requests on the wire

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

    private String isSet(OperationInfo.Param p) {
        if (p.member().isRequired()) {
            return "true";
        }
        return "input." + p.field() + ".is_some()";
    }

    private void buildFn(RustWriter w, OperationInfo op) {
        String in = op.inputType();
        w.l("fn build_" + fnName(op) + "(input: &" + in + ") -> Result<rt::Request, rt::Error> {\n");
        if (op.fields.isEmpty()) {
            w.l("    let _ = input;\n");
        }
        for (OperationInfo.Param p : op.all) {
            if (p.location() == HttpBinding.Location.LABEL && target(p.member()).isStringShape()) {
                w.l("    if input." + p.field() + ".is_empty() {\n        return Err(rt::Error::missing_input(" + Names.str(op.name) + ", "
                        + Names.str(p.member().getMemberName()) + "));\n    }\n");
            }
        }
        List<String> parts = new ArrayList<>();
        StringBuilder literal = new StringBuilder();
        for (SmithyPattern.Segment seg : op.http.getUri().getSegments()) {
            literal.append('/');
            if (seg.isLabel()) {
                OperationInfo.Param p = op.param(seg.getContent()).orElseThrow();
                if (seg.isGreedyLabel() && !target(p.member()).isStringShape()) {
                    throw new CodegenException(op.op.getId() + ": a greedy label must be a string");
                }
                parts.add(Names.str(literal.toString()));
                String labelFn = seg.isGreedyLabel() ? "rt::path_greedy_label" : "rt::path_label";
                parts.add(target(p.member()).isStringShape()
                        ? "&" + labelFn + "(&input." + p.field() + ")"
                        : "&rt::path_label(&" + format(target(p.member()), "&input." + p.field(), p.member()) + ")");
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
            String v = "input." + p.field();
            if (t instanceof ListShape list) {
                Shape item = model.expectShape(list.getMember().getTarget());
                String iter = p.member().isRequired() ? v + ".iter()" : v + ".iter().flatten()";
                w.l("    for v in " + iter + " {\n        " + set + Names.str(p.wire()) + ", " + format(item, "v", p.member()) + ");\n    }\n");
            } else if (!p.member().isRequired()) {
                w.l("    if let Some(v) = &" + v + " {\n        " + set + Names.str(p.wire()) + ", " + format(t, "v", p.member()) + ");\n    }\n");
            } else {
                w.l("    " + set + Names.str(p.wire()) + ", " + format(t, t.isTimestampShape() ? "&" + v : v, p.member()) + ");\n");
            }
        }
        for (OperationInfo.Param p : sinceMembers(op)) {
            w.l("    if " + isSet(p) + " {\n        req.since(" + Names.str(p.member().getMemberName()) + ", "
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

    private void reader(RustWriter w, OperationInfo op) {
        String result = resultType(op);
        Map<String, HttpBinding> bindings = HttpBindingIndex.of(model).getResponseBindings(op.op);
        boolean body = false;
        for (HttpBinding b : payload(op).isPresent() ? List.<HttpBinding>of() : bindings.values()) {
            if (b.getLocation() == HttpBinding.Location.DOCUMENT) {
                body = true;
            } else if (b.getLocation() == HttpBinding.Location.PAYLOAD || b.getMember().hasTrait(HttpResponseCodeTrait.class)
                    || b.getLocation() == HttpBinding.Location.PREFIX_HEADERS) {
                throw new CodegenException(b.getMember().getId() + ": " + b.getLocation() + " output bindings are not supported yet");
            }
        }
        Optional<MemberShape> payload = payload(op);
        if (payload.isPresent()) {
            // A thing: the body is the thing; the ETag header fills `etag` when the body has none; the response's
            // metadata goes on the thing (PROTOCOL.md 4.2). The output's other headers are in that metadata.
            StructureShape thing = model.expectShape(payload.get().getTarget(), StructureShape.class);
            w.l("async fn read_" + fnName(op) + "(resp: rt::Response) -> Result<" + result + ", rt::Error> {\n"
                    + "    let metadata = resp.metadata();\n    let mut out: " + result + " = resp.json().await?;\n");
            thing.getMember("etag").ifPresent(m -> w.l(m.isRequired()
                    ? "    if out.etag.is_empty() {\n        out.etag = metadata.etag.clone().unwrap_or_default();\n    }\n"
                    : "    if out.etag.is_none() {\n        out.etag = metadata.etag.clone();\n    }\n"));
            w.l("    out.response_metadata = rt::ThingMetadata(Some(metadata));\n    Ok(out)\n}\n\n");
            return;
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

    // ------------------------------------------------------------------ request builders

    /** Members a scope or a leading argument fills somewhere, and the labels: kept when `input(…)` replaces the rest. */
    Set<String> filledMembers(OperationInfo op) {
        Set<String> out = new LinkedHashSet<>();
        for (Placed p : placements.get(op.op.getId())) {
            p.method().fills.forEach(f -> out.add(f.member()));
        }
        for (OperationInfo.Param p : op.fields) {
            if (p.location() == HttpBinding.Location.LABEL) {
                out.add(p.member().getMemberName());
            }
        }
        return out;
    }

    /** The upload target of an operation when it is a member of the input itself ({@code uploadId}). */
    Optional<UploadTargets.Target> topLevelTarget(OperationInfo op) {
        UploadTargets.Target t = facts.uploads.byOperation.get(op.op.getId());
        return t != null && t.path().size() == 1 ? Optional.of(t) : Optional.empty();
    }

    /** For an estimate beside a job that takes a file: the member that takes the file's description, and whether it is a list. */
    Optional<OperationInfo.Param> describedMember(OperationInfo est) {
        for (OperationInfo.Param p : est.fields) {
            Shape t = target(p.member());
            Shape item = t instanceof ListShape l ? model.expectShape(l.getMember().getTarget()) : t;
            if (item.getId().getName().equals("UploadDescription")) {
                return Optional.of(p);
            }
        }
        return Optional.empty();
    }

    /** Whether an estimate placement takes the job's file. */
    boolean takesFile(Placed p) {
        OperationInfo job = p.job().map(j -> info(j.operation.getId())).orElse(null);
        return job != null && topLevelTarget(job).isPresent() && describedMember(info(p.method().operation.getId())).isPresent();
    }

    /**
     * The arguments a method takes after its leading identifiers (and the file): the input's required members the scope
     * does not fill, in model order. With a file to upload in place of a member, every other member is a setter.
     */
    List<OperationInfo.Param> positional(OperationInfo op, ScopeTree.Method m, boolean withFile) {
        List<OperationInfo.Param> out = new ArrayList<>();
        if (withFile) {
            return out;
        }
        for (OperationInfo.Param p : op.fields) {
            if (!p.member().isRequired() || m.fills(p.member().getMemberName()) || p.location() == HttpBinding.Location.LABEL) {
                continue;
            }
            out.add(p);
        }
        // The member a create's new scope is named by comes first: `kb.fields().create(key, …)`.
        m.creates.filter(c -> c.source().startsWith("input:")).ifPresent(c -> {
            String first = c.source().substring("input:".length());
            out.sort(java.util.Comparator.comparing(p -> p.member().getMemberName().equals(first) ? 0 : 1));
        });
        return out;
    }

    /** The Rust parameter type a setter or a positional argument takes for a member. */
    String paramType(MemberShape m) {
        Shape t = target(m);
        if (t.isStringShape() && !t.isEnumShape()) {
            return "impl Into<String>";
        }
        if (t.isEnumShape() || t.isStructureShape() || t.isUnionShape() || t.isMapShape() || t.isDocumentShape()) {
            return "impl Into<" + ctx.types().base(t) + ">";
        }
        if (t instanceof ListShape l) {
            Shape item = model.expectShape(l.getMember().getTarget());
            if (item.isStringShape()) {
                return "impl IntoIterator<Item = impl Into<" + ctx.types().base(item) + ">>";
            }
            return "impl IntoIterator<Item = " + ctx.types().base(item) + ">";
        }
        return ctx.types().base(t);
    }

    /** The expression that turns a parameter {@code v} of {@link #paramType} into the member's field value. */
    String convert(MemberShape m, String v) {
        Shape t = target(m);
        String base;
        if (t instanceof ListShape) {
            Shape item = model.expectShape(((ListShape) t).getMember().getTarget());
            base = item.isStringShape() || item.isEnumShape() ? v + ".into_iter().map(Into::into).collect()" : v + ".into_iter().collect()";
        } else if (t.isStringShape() || t.isEnumShape() || t.isStructureShape() || t.isUnionShape() || t.isMapShape() || t.isDocumentShape()) {
            base = v + ".into()";
        } else {
            base = v;
        }
        if (ctx.types().member(m).contains("Box<")) {
            base = "Box::new(" + base + ")";
        }
        return m.isRequired() ? base : "Some(" + base + ")";
    }

    private void request(RustWriter w, OperationInfo op) {
        String req = requestType(op);
        String in = op.inputType();
        List<Placed> places = placements.get(op.op.getId());
        boolean withFile = places.stream().anyMatch(this::takesFile);
        Set<String> filled = filledMembers(op);
        StringBuilder where = new StringBuilder();
        for (Placed p : places) {
            where.append(where.length() == 0 ? "" : ", ").append("`").append(scopes.rustPath(p)).append("`");
        }
        w.l(Names.doc("The request " + op.name + " sends: made by " + where + ". Set the members the call did not take as arguments, "
                + "and the call options, then `.send().await` it (or `.await` it)" + (op.kind == OperationInfo.Kind.PAGINATED
                ? "; a list is read with `items()`, `pages()` or `collect()`" : "") + ". It sends nothing until then.", ""));
        w.l("#[derive(Debug, Clone)]\n#[must_use = \"a request does nothing until it is sent\"]\npub struct " + req + " {\n"
                + "    core: rt::Client,\n    input: " + in + ",\n    opts: rt::CallOptions,\n    /// The identifiers of the scope the request was made on.\n    #[allow(dead_code)]\n    ids: Vec<String>,\n"
                + (withFile ? "    file: Option<rt::UploadFile>,\n" : "")
                + (attached(op).isPresent() ? "    /// Files and uploads to attach, sent before the request (PROTOCOL.md 16, \"Attachments\").\n    attach: Option<Vec<rt::Attachment>>,\n" : "")
                + "}\n\n");
        w.l("impl " + req + " {\n");
        w.l("    pub(crate) fn new(core: rt::Client, input: " + in + ", ids: Vec<String>) -> Self {\n        " + req
                + " {\n            core,\n            input,\n            opts: rt::CallOptions::default(),\n            ids,\n"
                + (withFile ? "            file: None,\n" : "") + (attached(op).isPresent() ? "            attach: None,\n" : "") + "        }\n    }\n\n");
        if (withFile) {
            w.l("    pub(crate) fn with_file(mut self, file: rt::UploadFile) -> Self {\n        self.file = Some(file);\n        self\n    }\n\n");
        }
        // Setters: every member a scope never fills and the method does not take as an argument everywhere.
        Set<String> positionalEverywhere = null;
        for (Placed p : places) {
            Set<String> names = new HashSet<>();
            positional(op, p.method(), takesFile(p) || topLevelTarget(op).isPresent()).forEach(x -> names.add(x.member().getMemberName()));
            if (positionalEverywhere == null) {
                positionalEverywhere = names;
            } else {
                positionalEverywhere.retainAll(names);
            }
        }
        Optional<OperationInfo.Param> described = withFile ? describedMember(op) : Optional.empty();
        for (OperationInfo.Param p : op.fields) {
            String member = p.member().getMemberName();
            if (filled.contains(member) || positionalEverywhere.contains(member)
                    || described.map(d -> d.member().getMemberName().equals(member)).orElse(false)) {
                continue;
            }
            if (attached(op).map(a -> a.member().getMemberName().equals(member)).orElse(false)) {
                w.l(Names.doc("Documents the message carries, in this order: each a file (a path, `UploadFile`, or a name with bytes) or "
                        + "`Attachment::upload_id(…)`. Each file is reserved for this conversation and uploaded before the message is "
                        + "sent; if one fails, no message is sent and the call raises that file's error. Each upload is used up when the "
                        + "message is saved, so sending the same files again uploads them again.", "    "));
                w.l("    pub fn attachments(mut self, v: impl IntoIterator<Item = impl Into<rt::Attachment>>) -> Self {\n"
                        + "        self.attach = Some(v.into_iter().map(Into::into).collect());\n        self\n    }\n\n");
                continue;
            }
            if (topLevelTarget(op).map(t -> t.leaf().getMemberName().equals(member)).orElse(false)) {
                // An upload's id in place of the file: the file is then not uploaded.
                w.l(Names.doc("Sends an existing upload's id in place of the file (`core().uploads().send`), which is then not uploaded.", "    "));
                w.l("    pub fn " + p.field() + "(mut self, v: impl Into<String>) -> Self {\n        self.input." + p.field() + " = "
                        + (p.member().isRequired() ? "v.into()" : "Some(v.into())") + ";\n        self.input."
                        + topLevelTarget(op).get().fileField() + " = None;\n        self\n    }\n\n");
                continue;
            }
            String setter = p.field();
            boolean clash = Set.of("send", "input", "options", "cancel_on", "new", "with_file", "wait", "watch").contains(setter)
                    || (op.kind == OperationInfo.Kind.PAGINATED && Set.of("items", "pages", "collect").contains(setter))
                    || (op.ifMatch.isPresent() && setter.equals("if_match")) || (op.idempotency.isPresent() && setter.equals("idempotency_key"));
            if (clash) {
                throw new CodegenException(op.op.getId() + ": member " + member + " clashes with a request method");
            }
            w.l(Names.doc(CaitlynRustCodegen.memberDoc(ctx, p.member()), "    "));
            w.l("    pub fn " + setter + "(mut self, v: " + paramType(p.member()) + ") -> Self {\n        self.input." + p.field() + " = "
                    + convert(p.member(), "v") + ";\n        self\n    }\n\n");
        }
        // input(…): every member at once, keeping what the scope filled.
        StringBuilder keep = new StringBuilder();
        for (OperationInfo.Param p : op.fields) {
            if (!filled.contains(p.member().getMemberName())) {
                continue;
            }
            keep.append(p.member().isRequired() && ctx.types().member(p.member()).equals("String")
                    ? "        if input." + p.field() + ".is_empty() {\n            input." + p.field() + " = std::mem::take(&mut self.input." + p.field() + ");\n        }\n"
                    : !p.member().isRequired()
                    ? "        if input." + p.field() + ".is_none() {\n            input." + p.field() + " = self.input." + p.field() + ".take();\n        }\n"
                    : "");
        }
        topLevelTarget(op).ifPresent(t -> keep.append("        if input." + t.fileField() + ".is_none() {\n            input." + t.fileField()
                + " = self.input." + t.fileField() + ".take();\n        }\n"));
        w.l(Names.doc("Sets every member at once, from an [`" + in + "`]. The identifiers the scope filled are kept where `input` leaves them empty.", "    "));
        if (withFile) {
            // The file's description is a member too: input(…) sets it, and the file is not described.
            keep.append("        self.file = None;\n");
        }
        w.l("    pub fn input(mut self, mut input: " + in + ") -> Self {\n" + keep + "        self.input = input;\n        self\n    }\n\n");
        op.ifMatch.ifPresent(p -> w.l("    /// Sends `If-Match: etag`" + (p.member().isRequired() ? " (required: without it the call fails with 428)" : "")
                + ": refused with [`Error::PreconditionFailed`] (412) if the thing changed since it was read.\n"
                + "    pub fn if_match(mut self, etag: impl Into<String>) -> Self {\n        self.opts = self.opts.if_match(etag);\n        self\n    }\n\n"));
        op.idempotency.ifPresent(p -> w.l("    /// Sends this idempotency key instead of a generated one (kept across retries either way).\n"
                + "    pub fn idempotency_key(mut self, key: impl Into<String>) -> Self {\n        self.opts = self.opts.idempotency_key(key);\n        self\n    }\n\n"));
        w.l("    /// Fails the call with [`Error::Cancelled`] when `token` fires, closing the connection.\n"
                + "    pub fn cancel_on(mut self, token: rt::CancellationToken) -> Self {\n        self.opts = self.opts.cancel_on(token);\n        self\n    }\n\n"
                + "    /// Replaces every call option at once.\n    pub fn options(mut self, opts: rt::CallOptions) -> Self {\n        self.opts = opts;\n        self\n    }\n\n");
        switch (op.kind) {
            case UNARY -> {
                unarySend(w, op, places);
                waitAndWatch(w, op, places.get(0));
            }
            case PAGINATED -> paginatedSend(w, op);
            case STREAM -> streamSend(w, op);
        }
        w.l("}\n\n");
        attached(op).ifPresent(at -> {
            String item = ctx.types().base(model.expectShape(((ListShape) target(at.member())).getMember().getTarget()));
            pendingTop.append("/// An upload already made, as an attachment: sent as it is.\nimpl From<" + item + "> for rt::Attachment {\n"
                    + "    fn from(r: " + item + ") -> Self {\n        rt::Attachment::Upload(r.upload_id)\n    }\n}\n\n");
        });
        if (op.kind != OperationInfo.Kind.PAGINATED) {
            String out = sendType(op);
            w.l("impl std::future::IntoFuture for " + req + " {\n    type Output = Result<" + out + ", Error>;\n"
                    + "    type IntoFuture = rt::BoxFuture<'static, Result<" + out + ", Error>>;\n\n"
                    + "    fn into_future(self) -> Self::IntoFuture {\n        self.send()\n    }\n}\n\n");
        }
    }

    /** What a request's send returns: the output, a stream, the new thing's scope, or the output with its wait. */
    String sendType(OperationInfo op) {
        if (op.kind == OperationInfo.Kind.STREAM) {
            return streamAlias(op);
        }
        String out = resultType(op);
        Placed p = placements.get(op.op.getId()).get(0);
        if (p.method().creates.isPresent()) {
            return "rt::Created<" + scopes.qualified(p.method().creates.get().collection().scope) + ", " + out + ">";
        }
        if (p.method().longRunning.isPresent()) {
            ScopeTree.Node follow = followScope(p);
            return "rt::Started<" + out + ", " + (isDelete(op) ? "()" : scopes.waitType(follow)) + ", " + watchStream(follow) + ", Error, crate::operations::Processing>";
        }
        return out;
    }

    boolean isDelete(OperationInfo op) {
        return model.getResourceShapes().stream().anyMatch(r -> r.getDelete().filter(op.op.getId()::equals).isPresent());
    }

    /** The scope a started call's wait follows: the nearest scope, at or above the call, watched the way the call says. */
    ScopeTree.Node followScope(Placed p) {
        ScopeTree.LongRunning lr = p.method().longRunning.orElseThrow();
        for (ScopeTree.Node n = p.node(); n != null; n = n.parent) {
            if (n.kind == ScopeTree.Kind.SCOPE && n.watch.isPresent() && n.watch.get().watch().equals(lr.watch())
                    && n.watch.get().filter().equals(lr.filter())) {
                return n;
            }
        }
        throw new CodegenException(p.method().operation.getId() + ": no scope above " + p.node().path() + " is watched as its @longRunning says");
    }

    /** The stream type a watched scope's watch() gives. */
    String watchStream(ScopeTree.Node scope) {
        return "crate::operations::" + streamAlias(info(scope.watch.orElseThrow().watch()));
    }

    /**
     * On a call that starts work, or creates a thing that can be waited on: {@code .wait()} (send, then wait) and
     * {@code .watch()} (send, then watch), so a job reads {@code kb.documents().create(path).wait().await?}.
     */
    private void waitAndWatch(RustWriter w, OperationInfo op, Placed p) {
        String wait;
        String watch;
        if (p.method().creates.isPresent()) {
            ScopeTree.Node scope = p.method().creates.get().collection().scope;
            if (scope.watch.isEmpty()) {
                return;
            }
            wait = scopes.waitType(scope);
            watch = watchStream(scope);
            w.l("    /// Sends the request, then waits until the work it started has ended, and returns the new thing as its `get` would.\n"
                    + "    pub fn wait(self) -> rt::Waiting<" + wait + ", Error, crate::operations::Processing> {\n        rt::Waiting::new(move |wopts, progress| {\n            Box::pin(async move {\n"
                    + "                let created = self.send().await?;\n                created.wait().options(wopts).progress(progress).await\n            })\n        })\n    }\n\n");
            w.l("    /// Sends the request, then watches the new thing: a snapshot first, then each change.\n"
                    + "    pub fn watch(self) -> rt::BoxFuture<'static, Result<" + watch + ", Error>> {\n"
                    + "        Box::pin(async move { self.send().await?.watch().send().await })\n    }\n");
            return;
        }
        if (p.method().longRunning.isEmpty()) {
            return;
        }
        ScopeTree.Node follow = followScope(p);
        wait = isDelete(op) ? "()" : scopes.waitType(follow);
        watch = watchStream(follow);
        w.l("    /// Sends the request, then waits until the work it started has ended" + (isDelete(op) ? " (the thing is gone)" : ", and returns the thing as its `get` would") + ".\n"
                + "    pub fn wait(self) -> rt::Waiting<" + wait + ", Error, crate::operations::Processing> {\n        rt::Waiting::new(move |wopts, progress| {\n            Box::pin(async move {\n"
                + "                let started = self.send().await?;\n                started.wait().options(wopts).progress(progress).await\n            })\n        })\n    }\n\n");
        w.l("    /// Sends the request, then watches the thing the work is on: a snapshot first, then each change.\n"
                + "    pub fn watch(self) -> rt::BoxFuture<'static, Result<" + watch + ", Error>> {\n"
                + "        Box::pin(async move { self.send().await?.watch().await })\n    }\n");
    }

    /** The job (Operation) a call's output names: {@code operation} or {@code job}. */
    String jobExpr(OperationInfo op) {
        for (String name : List.of("operation", "job")) {
            Optional<MemberShape> m = op.output.getMember(name);
            if (m.isPresent()) {
                return m.get().isRequired() ? "Some(out." + name + ".id.clone())" : "out." + name + ".as_ref().map(|j| j.id.clone())";
            }
        }
        return "None";
    }

    private void unarySend(RustWriter w, OperationInfo op, List<Placed> places) {
        String out = sendType(op);
        String req = requestType(op);
        boolean withFile = places.stream().anyMatch(this::takesFile);
        w.l("    /// Sends the request.\n    pub fn send(self) -> rt::BoxFuture<'static, Result<" + out + ", Error>> {\n");
        w.l("        let " + req + " {\n            core,\n            mut input,\n            opts,\n            ids,\n" + (withFile ? "            file,\n" : "")
                + "        } = self;\n        let _ = &ids;\n");
        w.l("        Box::pin(async move {\n");
        w.l(uploadStep(op));
        if (withFile) {
            OperationInfo.Param d = describedMember(op).orElseThrow();
            StructureShape ds = model.expectShape(target(d.member()) instanceof ListShape l ? l.getMember().getTarget() : d.member().getTarget(),
                    StructureShape.class);
            for (String req2 : List.of("name", "contentType", "byteSize")) {
                ds.getMember(req2).orElseThrow(() -> new CodegenException(ds.getId() + " has no " + req2));
            }
            String desc = ctx.types().base(ds) + " {\n                    name: described.name,\n                    content_type: described.content_type,\n"
                    + "                    byte_size: described.size as i64,\n"
                    + (ds.getMember("hints").isPresent()
                            ? "                    hints: described.hints.and_then(|h| serde_json::from_value(h).ok()),\n" : "")
                    + "                    ..Default::default()\n                }";
            boolean list = target(d.member()) instanceof ListShape;
            String value = list ? "vec![" + desc + "]" : desc;
            w.l("            if let Some(file) = file {\n                // Only the file's description is sent (PROTOCOL.md 10); it is never hashed.\n"
                    + "                let described = core.describe_file(&file, &opts).await.map_err(Error::from)?;\n"
                    + "                input." + d.field() + " = " + (d.member().isRequired() ? value : "Some(" + value + ")") + ";\n            }\n");
        }
        for (OperationInfo.Param p : op.fields) {
            if (p.member().isRequired() && target(p.member()).getId().getName().equals("FolderPath") && ctx.types().member(p.member()).equals("String")
                    && p.location() == HttpBinding.Location.DOCUMENT) {
                w.l("            if input." + p.field() + ".is_empty() {\n                input." + p.field() + " = \"/\".to_owned(); // folders default to the root\n            }\n");
            }
        }
        Placed first = places.get(0);
        Optional<ScopeTree.NewScope> creates = first.method().creates;
        if (creates.isPresent() && creates.get().source().startsWith("input:")) {
            w.l("            let new_id = input." + Names.snake(creates.get().source().substring("input:".length())) + ".clone();\n");
        }
        w.l("            let req = build_" + fnName(op) + "(&input).map_err(Error::from)?;\n"
                + "            let resp = core.send(&OP_" + Names.constant(op.name) + ", req, &opts).await.map_err(Error::from)?;\n"
                + "            let out = read_" + fnName(op) + "(resp).await.map_err(Error::from)?;\n");
        if (creates.isPresent()) {
            ScopeTree.Node collection = creates.get().collection();
            String source = creates.get().source();
            if (source.startsWith("output:")) {
                List<String> full = List.of(source.substring("output:".length()).split("\\."));
                // A call that returns the thing: the identifier is on the thing itself.
                List<String> path = payload(op).filter(m -> m.getMemberName().equals(full.get(0))).isPresent()
                        ? full.subList(1, full.size()) : full;
                w.l("            let new_id = out." + String.join(".", path.stream().map(Names::snake).toList()) + ".clone();\n");
            }
            // The new scope's identifiers: the collection's parents' (by name, from the placing scope's), then the new one.
            List<String> placing = scopes.contextIds(first.node());
            List<String> picks = new ArrayList<>();
            for (String id : scopes.contextIds(collection)) {
                int at = placing.indexOf(id);
                if (at < 0) {
                    throw new CodegenException(op.op.getId() + ": " + id + " for the new scope is not known where the call is made");
                }
                picks.add("ids[" + at + "].clone()");
            }
            picks.add("new_id");
            String job = first.method().longRunning.isPresent() ? jobExpr(op) : "None";
            w.l("            let job = " + job + ";\n            let scope = " + scopes.qualified(collection.scope) + "::from_ids(core, vec![" + String.join(", ", picks) + "]);\n"
                    + "            Ok(rt::Created::new(scope, out, job))\n");
        } else if (first.method().longRunning.isPresent()) {
            if (places.size() != 1) {
                throw new CodegenException(op.op.getId() + ": a call that starts work is offered in one place only");
            }
            ScopeTree.Node follow = followScope(first);
            // A call that cancels the work it follows (@longRunning(cancels: true)) has a wait that returns the thing;
            // every other wait raises CANCELLED (PROTOCOL.md 16).
            String fn = isDelete(op) ? "follow_gone" : first.method().longRunning.get().cancels() ? "follow_cancel" : "follow_job";
            w.l("            let job: Option<String> = " + jobExpr(op) + ";\n            let scope = " + scopes.qualified(follow) + "::from_ids(core, ids);\n"
                    + "            let watcher = scope.clone();\n"
                    + "            Ok(rt::Started::new(out, move || scope." + fn + "(job.clone()), move || watcher.watch().send()))\n");
        } else {
            w.l("            Ok(out)\n");
        }
        w.l("        })\n    }\n");
    }

    private void paginatedSend(RustWriter w, OperationInfo op) {
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
        w.l("    /// Every item, fetching pages as needed (`next().await`, or `collect().await` for all of them).\n"
                + "    pub fn items(self) -> rt::Items<" + page + ", " + itemType + ", Error> {\n"
                + "        rt::Items::new(self.pages(), |p| " + itemsExpr + ")\n    }\n\n");
        w.l("    /// Every item, read to the last page.\n    pub async fn collect(self) -> Result<Vec<" + itemType + ">, Error> {\n"
                + "        self.items().collect().await\n    }\n\n");
        w.l("    /// The pages, from the `cursor` set (normally none) to the last page.\n    pub fn pages(self) -> rt::Pages<" + page + ", Error> {\n"
                + "        let " + requestType(op) + " { core, input, opts, .. } = self;\n        let start = input." + cursorField + ".clone();\n"
                + "        rt::Pages::new(start, move |cursor, opts| {\n            let core = core.clone();\n"
                + "            let mut input = input.clone();\n            input." + cursorField + " = cursor;\n            Box::pin(async move {\n"
                + "                let req = build_" + fnName(op) + "(&input).map_err(Error::from)?;\n"
                + "                let resp = core.send(&OP_" + Names.constant(op.name) + ", req, &opts).await.map_err(Error::from)?;\n"
                + "                let out = read_" + fnName(op) + "(resp).await.map_err(Error::from)?;\n"
                + "                let next = out." + Names.snake(next.getMemberName()) + ".clone();\n                Ok((out, next))\n"
                + "            })\n        })\n        .options(opts)\n    }\n");
    }

    // ------------------------------------------------------------------ streams

    private final Set<String> emittedFinals = new HashSet<>();
    private final Map<String, String> streamAliases = new LinkedHashMap<>();

    private record StreamTypes(String union, String finalType, String finalFn, String finalDef) {}

    private StreamTypes streamTypes(OperationInfo op) {
        ObjectNode sse = op.sse.orElseThrow();
        UnionShape union = model.expectShape(ShapeId.from(sse.expectStringMember("events").getValue()), UnionShape.class);
        String u = Names.pascal(union.getId().getName());
        Optional<String> fin = sse.getStringMember("final").map(s -> s.getValue());
        if (fin.isEmpty()) {
            return new StreamTypes(u, "()", "None", "");
        }
        MemberShape fm = union.getMember(fin.get()).orElseThrow(() -> new CodegenException(op.op.getId() + ": no union member " + fin.get()));
        StructureShape ft = model.expectShape(fm.getTarget(), StructureShape.class);
        if (ft.getAllMembers().size() != 1) {
            throw new CodegenException(ft.getId() + ": the final event must have exactly one member (PROTOCOL.md lint rule 4)");
        }
        MemberShape only = ft.getAllMembers().values().iterator().next();
        String variant = Names.pascal(fm.getMemberName());
        String finalType = ctx.types().member(only);
        String fn = "final_" + Names.snake(union.getId().getName()) + "_" + Names.snake(fm.getMemberName());
        String def = emittedFinals.add(fn) ? "fn " + fn + "(ev: &" + u + ") -> Option<" + finalType + "> {\n    match ev {\n        " + u + "::" + variant
                + "(v) => Some(v." + Names.snake(only.getMemberName()) + ".clone()),\n        _ => None,\n    }\n}\n\n" : "";
        return new StreamTypes(u, finalType, "Some(" + fn + ")", def);
    }

    /**
     * A stream's type alias. It is named after its event union, as SendMessage's ConversationEventStream is. When
     * operations stream the same union and only some of them end with a final event, the ones without
     * (WatchConversation, which carries on until it is closed) are named after the operation instead.
     */
    String streamAlias(OperationInfo op) {
        ObjectNode sse = op.sse.orElseThrow();
        String events = sse.expectStringMember("events").getValue();
        String union = Names.pascal(ShapeId.from(events).getName());
        boolean siblingHasFinal = ops.values().stream()
                .filter(o -> o.sse.isPresent() && o.sse.get().expectStringMember("events").getValue().equals(events))
                .anyMatch(o -> o.sse.get().getStringMember("final").isPresent());
        boolean ownFinal = sse.getStringMember("final").isPresent();
        return !ownFinal && siblingHasFinal ? Names.pascal(op.name) + "Stream" : union + "Stream";
    }

    private void streamSend(RustWriter w, OperationInfo op) {
        StreamTypes st = streamTypes(op);
        String alias = streamAlias(op);
        String target = "rt::Stream<" + st.union() + ", " + st.finalType() + ", Error>";
        String prev = streamAliases.putIfAbsent(alias, target);
        StringBuilder top = new StringBuilder(st.finalDef());
        if (prev == null) {
            boolean hasFinal = !st.finalType().equals("()");
            top.append(Names.doc("A stream of [`" + st.union() + "`] events. "
                    + (hasFinal ? "Call `next().await` until it returns `None`, then `final_message().await` for the [`" + st.finalType()
                            + "`] (it drains the stream if needed)."
                            : "Call `next().await` until you have what you need, then drop the stream: it has no final event.")
                    + " A dropped connection is resumed where the model allows; dropping the stream closes the connection.", ""));
            top.append("pub type ").append(alias).append(" = ").append(target).append(";\n\n");
        } else if (!prev.equals(target)) {
            throw new CodegenException(op.op.getId() + ": two streams of " + st.union() + " with different final events");
        }
        ObjectNode sse = op.sse.orElseThrow();
        String resume = "None";
        boolean fresh = false;
        StringBuilder resumeSetup = new StringBuilder();
        Optional<String> resumeWith = sse.getStringMember("resumeWith").map(s -> s.getValue());
        if (resumeWith.isPresent()) {
            OperationInfo r = ops.get(ShapeId.from(resumeWith.get()));
            if (r == null) {
                throw new CodegenException(op.op.getId() + ": resumeWith " + resumeWith.get() + " is not a generated operation");
            }
            boolean self = r.op.getId().equals(op.op.getId());
            StringBuilder fill = new StringBuilder();
            boolean lastSet = false;
            for (OperationInfo.Param rp : r.all) {
                if (rp.location() == HttpBinding.Location.HEADER && rp.wire().equalsIgnoreCase("Last-Event-ID")) {
                    // Before any event, the request goes as it was, with no Last-Event-ID; after one, Last-Event-ID
                    // carries the position in place of a watch's `after` cursor (PROTOCOL.md 5.6).
                    String dropAfter = self
                            ? r.all.stream().filter(p -> p.member().getMemberName().equals("after")).findFirst()
                                    .map(p -> " rin." + p.field() + " = None;").orElse("")
                            : "";
                    fill.append("                    if !last_event_id.is_empty() { rin.").append(rp.field()).append(" = ")
                            .append(rp.member().isRequired() ? "last_event_id" : "Some(last_event_id)").append(";").append(dropAfter).append(" }\n");
                    lastSet = true;
                    continue;
                }
                if (rp.location() != HttpBinding.Location.LABEL || self) {
                    continue;
                }
                String member = rp.member().getMemberName();
                OperationInfo.Param src = op.param(member).orElseThrow(() ->
                        new CodegenException(r.op.getId() + ": label " + member + " has no member of the same name in " + op.op.getId()));
                fill.append("                    rin.").append(rp.field()).append(" = resume_input.").append(src.field()).append(".clone();\n");
            }
            if (!lastSet) {
                if (!self) {
                    throw new CodegenException(r.op.getId() + ": a resumeWith operation needs a Last-Event-ID header member");
                }
                // A watch with no cursor (a knowledge base's): the same request again, starting from a snapshot (PROTOCOL.md 16).
                fresh = true;
                fill.append("                    let _ = last_event_id;\n");
            }
            resumeSetup.append("            let resume_input = input.clone();\n            let resume_core = core.clone();\n"
                    + "            let resume_opts = opts.cancellation_only();\n"
                    + "            let resume: rt::stream::Resume = Box::new(move |last_event_id: String| {\n"
                    + "                let core = resume_core.clone();\n                let opts = resume_opts.clone();\n"
                    + "                let resume_input = resume_input.clone();\n                Box::pin(async move {\n"
                    + "                    let mut rin = " + (self ? "resume_input.clone()" : r.inputType() + "::default()") + ";\n" + fill
                    + "                    let rreq = build_" + fnName(r) + "(&rin)?;\n"
                    + "                    core.send(&OP_" + Names.constant(r.name) + ", rreq, &opts).await\n                })\n            });\n");
            resume = "Some(resume)";
        }
        w.l("    /// Sends the request; the stream starts once the response does. Errors during the stream (a failure event, a\n"
                + "    /// connection that could not be resumed, cancellation) end it with that error.\n"
                + "    pub fn send(self) -> rt::BoxFuture<'static, Result<" + alias + ", Error>> {\n"
                + "        let " + requestType(op) + " { core, input, opts" + (attached(op).isPresent() ? ", attach" : "") + ", .. } = self;\n        Box::pin(async move {\n"
                + attachStep(op)
                + "            let req = build_" + fnName(op) + "(&input).map_err(Error::from)?;\n"
                + "            let resp = core.send(&OP_" + Names.constant(op.name) + ", req, &opts).await.map_err(Error::from)?;\n"
                + resumeSetup
                + "            Ok(rt::Stream::open(resp, rt::StreamSpec {\n                decode: decode_" + Names.snake(st.union()) + ",\n"
                + "                final_of: " + st.finalFn() + ",\n                map_err: Error::from,\n                resume: " + resume + ",\n"
                + "                fresh: " + fresh + ",\n            }))\n        })\n    }\n");
        // The alias and the final-event function go after the impl block (written by the caller with the rest).
        pendingTop.append(top);
    }

    /**
     * A list member of uploads to attach ({@code attachments: [{uploadId}]}) on an operation whose label the upload
     * purpose names ({@code purpose.conversationId}): the request takes files for it and uploads them first.
     */
    Optional<OperationInfo.Param> attached(OperationInfo op) {
        Optional<OperationInfo.Param> purpose = presigned().param("purpose");
        if (purpose.isEmpty()) {
            return Optional.empty();
        }
        StructureShape ps = model.expectShape(purpose.get().member().getTarget(), StructureShape.class);
        boolean scoped = op.fields.stream().anyMatch(p -> p.location() == HttpBinding.Location.LABEL && ps.getMember(p.member().getMemberName()).isPresent());
        if (!scoped) {
            return Optional.empty();
        }
        for (OperationInfo.Param p : op.fields) {
            if (target(p.member()) instanceof ListShape l && model.expectShape(l.getMember().getTarget()) instanceof StructureShape item
                    && item.getAllMembers().size() == 1 && item.getMember("uploadId").filter(MemberShape::isRequired).isPresent()) {
                return Optional.of(p);
            }
        }
        return Optional.empty();
    }

    /** The start of a send with attachments: each file reserved with the label as its purpose and uploaded, in order. */
    private String attachStep(OperationInfo op) {
        Optional<OperationInfo.Param> a = attached(op);
        if (a.isEmpty()) {
            return "";
        }
        OperationInfo presigned = presigned();
        StructureShape ps = model.expectShape(presigned.param("purpose").orElseThrow().member().getTarget(), StructureShape.class);
        OperationInfo.Param label = op.fields.stream().filter(p -> p.location() == HttpBinding.Location.LABEL && ps.getMember(p.member().getMemberName()).isPresent())
                .findFirst().orElseThrow();
        MemberShape pm = ps.getMember(label.member().getMemberName()).orElseThrow();
        String item = ctx.types().base(model.expectShape(((ListShape) target(a.get().member())).getMember().getTarget()));
        String value = "input." + label.field() + ".clone()";
        return "            let mut input = input;\n            if let Some(attach) = attach {\n                let mut refs = Vec::new();\n"
                + "                for a in attach {\n                    let upload_id = match a {\n                        rt::Attachment::Upload(id) => id,\n"
                + "                        rt::Attachment::File(file) => {\n                            let purpose = " + ctx.types().base(ps) + " {\n"
                + "                                " + Names.snake(pm.getMemberName()) + ": " + (pm.isRequired() ? value : "Some(" + value + ")") + ",\n"
                + "                                ..Default::default()\n                            };\n"
                + "                            crate::scope::send_upload(&core, file, Some(purpose), opts.cancellation_only()).await?.id\n"
                + "                        }\n                    };\n"
                + "                    refs.push(" + item + " {\n                        upload_id,\n                        ..Default::default()\n                    });\n"
                + "                }\n                input." + a.get().field() + " = " + (a.get().member().isRequired() ? "refs" : "Some(refs)") + ";\n            }\n";
    }

    /** Items a stream's send writes at the top level: written after the request's impl. */
    private final StringBuilder pendingTop = new StringBuilder();

    // ------------------------------------------------------------------ uploads (PROTOCOL.md 10)

    /** The @presignedUpload operation an @uploadTarget operation uploads with. */
    OperationInfo presigned() {
        List<OperationInfo> found = ops.values().stream().filter(o -> o.op.findTrait(CaitlynTraits.PRESIGNED_UPLOAD).isPresent()).toList();
        if (found.size() != 1) {
            throw new CodegenException("@uploadTarget needs exactly one @presignedUpload operation, found " + found.size());
        }
        return found.get(0);
    }

    /**
     * The start of an @uploadTarget operation's call (PROTOCOL.md 10): a file set beside the identifier is uploaded
     * with the @presignedUpload operation (with the purpose the identifier's documentation names), and the upload's id
     * is sent in its place.
     */
    private String uploadStep(OperationInfo op) {
        UploadTargets.Target t = facts.uploads.byOperation.get(op.op.getId());
        if (t == null) {
            return "";
        }
        OperationInfo presigned = presigned();
        StringBuilder walk = new StringBuilder();
        List<MemberShape> path = t.path();
        String holder;
        if (path.size() == 1) {
            holder = "            let holder = &mut input;\n            {\n";
        } else {
            walk.append("Some(&mut input)");
            for (MemberShape m : path.subList(0, path.size() - 1)) {
                String f = Names.snake(m.getMemberName());
                walk.append(m.isRequired() ? ".map(|v| &mut v." + f + ")" : ".and_then(|v| v." + f + ".as_mut())");
            }
            holder = "            if let Some(holder) = " + walk + " {\n";
        }
        MemberShape leaf = t.leaf();
        String id = Names.snake(leaf.getMemberName());
        String isSetExpr = leaf.isRequired() ? "!holder." + id + ".is_empty()" : "holder." + id + ".is_some()";
        String purpose = "None";
        if (t.purpose().isPresent()) {
            OperationInfo.Param pp = presigned.param("purpose").orElseThrow(() ->
                    new CodegenException(op.op.getId() + ": " + t.dotted() + " names an upload purpose, but " + presigned.name + " takes none"));
            StructureShape ps = model.expectShape(pp.member().getTarget(), StructureShape.class);
            MemberShape pm = ps.getMember(t.purpose().get()).orElseThrow(() ->
                    new CodegenException(op.op.getId() + ": " + t.dotted() + " names the upload purpose " + t.purpose().get() + ", which " + ps.getId() + " does not have"));
            if (!target(pm).isBooleanShape()) {
                throw new CodegenException(pm.getId() + ": an upload purpose named by @uploadTarget must be a boolean");
            }
            purpose = "Some(" + ctx.types().base(ps) + " {\n                        " + Names.snake(pm.getMemberName()) + ": "
                    + (pm.isRequired() ? "true" : "Some(true)") + ",\n                        ..Default::default()\n                    })";
        }
        return holder
                + "                if let Some(file) = holder." + t.fileField() + ".take() {\n"
                + "                    if " + isSetExpr + " {\n"
                + "                        return Err(Error::Input(rt::InputError::new(\n"
                + "                            " + Names.str(op.name) + ",\n"
                + "                            " + Names.str(t.dotted()) + ",\n"
                + "                            " + Names.str("is set together with the file to upload in its place; set one of them") + ",\n"
                + "                        )));\n                    }\n"
                + "                    let up = crate::scope::send_upload(&core, file, " + purpose + ", opts.cancellation_only()).await?;\n"
                + "                    holder." + id + " = " + (leaf.isRequired() ? "up.id" : "Some(up.id)") + ";\n"
                + "                }\n            }\n";
    }

    // ------------------------------------------------------------------ the readers shorthand

    /**
     * {@code access().set().readers(…)} takes {@code "inherit"}, {@code "everyone"} or roles and people (DX review 4.1,
     * PROTOCOL.md 11 {@code access.readers-shorthand}), mapped to the model's {@code {kind, roles, people}}.
     */
    private void readersShorthand(RustWriter w) {
        w.l(pendingTop.toString());
        Optional<StructureShape> readers = model.getStructureShapes().stream().filter(s -> s.getId().getName().equals("Readers")).findFirst();
        if (readers.isEmpty()) {
            return;
        }
        StructureShape r = readers.get();
        MemberShape kind = r.getMember("kind").orElseThrow(() -> new CodegenException(r.getId() + " has no kind"));
        String kindType = ctx.types().base(target(kind));
        for (String m : List.of("roles", "people")) {
            if (r.getMember(m).map(MemberShape::isRequired).orElse(true)) {
                throw new CodegenException(r.getId() + "$" + m + " must be an optional member for the readers shorthand");
            }
        }
        w.l("impl Readers {\n    /// The same readers as the folder it is in (`inherit`). Refused on the root folder, which has no parent.\n"
                + "    pub fn inherit() -> Self {\n        Readers {\n            kind: " + kindType + "::from(\"inherit\"),\n            ..Default::default()\n        }\n    }\n\n"
                + "    /// Anyone signed in who may read the knowledge base (`everyone`).\n"
                + "    pub fn everyone() -> Self {\n        Readers {\n            kind: " + kindType + "::from(\"everyone\"),\n            ..Default::default()\n        }\n    }\n\n"
                + "    /// Only these roles and people (`specific`).\n"
                + "    pub fn specific(roles: impl IntoIterator<Item = impl Into<String>>, people: impl IntoIterator<Item = impl Into<String>>) -> Self {\n"
                + "        Readers {\n            kind: " + kindType + "::from(\"specific\"),\n            roles: Some(roles.into_iter().map(Into::into).collect()),\n"
                + "            people: Some(people.into_iter().map(Into::into).collect()),\n            ..Default::default()\n        }\n    }\n\n"
                + "    /// Only these roles.\n    pub fn roles(roles: impl IntoIterator<Item = impl Into<String>>) -> Self {\n"
                + "        Readers {\n            kind: " + kindType + "::from(\"specific\"),\n            roles: Some(roles.into_iter().map(Into::into).collect()),\n"
                + "            ..Default::default()\n        }\n    }\n\n"
                + "    /// Only these people.\n    pub fn people(people: impl IntoIterator<Item = impl Into<String>>) -> Self {\n"
                + "        Readers {\n            kind: " + kindType + "::from(\"specific\"),\n            people: Some(people.into_iter().map(Into::into).collect()),\n"
                + "            ..Default::default()\n        }\n    }\n}\n\n");
        w.l("/// `\"inherit\"` or `\"everyone\"`: `.readers(\"inherit\")`. Any other value is sent as the kind it names.\n"
                + "impl From<&str> for Readers {\n    fn from(kind: &str) -> Self {\n        Readers {\n            kind: " + kindType + "::from(kind),\n"
                + "            ..Default::default()\n        }\n    }\n}\n\n");
    }

    // ------------------------------------------------------------------ a thing's processing (PROTOCOL.md 16)

    /**
     * {@code Processing}, what a wait's progress callback and a watch event's {@code processing()} give: a document's
     * DocumentProcessing, or the running job of a batch, a folder or a knowledge base. Written when the knowledge base's
     * watch has its snapshot, document.progress and job.progress events.
     */
    private void processing(RustWriter w) {
        Optional<UnionShape> union = model.getUnionShapes().stream().filter(u -> u.getMember("snapshot").isPresent()
                && u.getMember("documentProgress").isPresent() && u.getMember("jobProgress").isPresent()).findFirst();
        if (union.isEmpty()) {
            throw new CodegenException("no watch has snapshot, documentProgress and jobProgress events: Processing needs them");
        }
        String u = Names.pascal(union.get().getId().getName());
        String decode = "decode_" + Names.snake(union.get().getId().getName());
        w.l("""
/// A thing's processing, as a wait's progress callback and a watch event's `processing()` give it: a document's
/// [`DocumentProcessing`] (its stage, percentage and time left), or the running [`Job`] of a batch, a folder or a
/// knowledge base.
#[derive(Debug, Clone, PartialEq)]
pub enum Processing {
    Document(Box<DocumentProcessing>),
    Job(Box<Job>),
}

impl Processing {
    /// How far it has got, from 0 to 100; it never moves back.
    pub fn percent(&self) -> Option<i32> {
        match self {
            Processing::Document(p) => Some(p.percent),
            Processing::Job(j) => j.percent,
        }
    }

    /// How long is left, once it has run long enough to say.
    pub fn eta(&self) -> Option<&Eta> {
        match self {
            Processing::Document(p) => p.eta.as_ref(),
            Processing::Job(j) => j.eta.as_ref(),
        }
    }

    /// A document's stage (`pages`, `passages`, …); a job has none.
    pub fn stage(&self) -> Option<&ProcessingStep> {
        match self {
            Processing::Document(p) => p.stage.as_ref(),
            Processing::Job(_) => None,
        }
    }

    /// For a wait's progress callback: a watch event as JSON, read for the document `id`'s processing (`thing`
    /// "document") or a running job (`thing` "job").
    pub(crate) fn observer(f: rt::watch::ProgressFn<Processing>, thing: &'static str, id: String) -> rt::watch::Observer {
        Box::new(move |v: &serde_json::Value| {
            let name = v["type"].as_str().unwrap_or_default().to_owned();
            let mut data = v.clone();
            if let serde_json::Value::Object(o) = &mut data {
                o.remove("type");
            }
            let Ok(bytes) = serde_json::to_vec(&data) else { return };
            let Ok(rt::Decoded::Event(ev)) = DECODE(&name, None, &bytes) else { return };
            let p = if thing == "document" {
                ev.processing_of(&id).filter(|p| matches!(p, Processing::Document(_)))
            } else {
                ev.processing().filter(|p| matches!(p, Processing::Job(_)))
            };
            if let Some(p) = p {
                f(&p);
            }
        })
    }
}

impl UNION {
    /// The processing this event carries, for a scope's watch: the watched document's, from a snapshot or a
    /// `document.progress`; or the running job, from the snapshot of a batch, a folder or a knowledge base, or a
    /// `job.progress`. `None` when it carries none.
    pub fn processing(&self) -> Option<Processing> {
        match self {
            UNION::Snapshot(s) => match &s.document {
                Some(d) => s.progress.iter().find(|p| p.document_id == d.id).map(|p| Processing::Document(Box::new(p.processing.clone()))),
                None => s.jobs.iter().find(|j| running(j)).map(|j| Processing::Job(Box::new(j.clone()))),
            },
            UNION::DocumentProgress(p) => Some(Processing::Document(Box::new(p.processing.clone()))),
            UNION::JobProgress(j) => Some(Processing::Job(Box::new(j.job.clone()))),
            _ => None,
        }
    }

    /// The processing of one document or job (by its id, or a job by its target's id), for the knowledge base's own
    /// watch, which carries many. `None` when this event carries none for it.
    pub fn processing_of(&self, id: &str) -> Option<Processing> {
        let is = |j: &Job| j.id == id || j.target.as_ref().is_some_and(|t| t.id == id);
        match self {
            UNION::Snapshot(s) => s
                .progress
                .iter()
                .find(|p| p.document_id == id)
                .map(|p| Processing::Document(Box::new(p.processing.clone())))
                .or_else(|| s.jobs.iter().find(|j| is(j) && running(j)).map(|j| Processing::Job(Box::new(j.clone())))),
            UNION::DocumentProgress(p) if p.document_id == id => Some(Processing::Document(Box::new(p.processing.clone()))),
            UNION::JobProgress(j) if is(&j.job) => Some(Processing::Job(Box::new(j.job.clone()))),
            _ => None,
        }
    }
}

fn running(j: &Job) -> bool {
    matches!(j.status.as_str(), "queued" | "running")
}

""".replace("UNION", u).replace("DECODE", decode));
    }

    // ------------------------------------------------------------------ errors

    static String variant(StructureShape e) {
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
                    + "`NO_FINAL_EVENT`, `UPLOAD_PUT_FAILED`, `CANCELLED` for work that was cancelled, with status 0), are "
                    + "[`Error::Api`]. A job that failed while you waited for it is the variant for its code's status. Every problem "
                    + "variant carries an [`ApiError`](rt::ApiError) with `status`, `code` and `request_id`; [`Error::api`] reads it "
                    + "whichever variant it is. A call that got no response is [`Error::Connection`], with status 0 and code "
                    + "`CONNECTION_ERROR` (PROTOCOL.md 6.5).", ""));
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
                    + "    /// The call's cancellation token fired.\n    Cancelled,\n"
                    + (hasSync() ? "    /// A `kb.ingestion().sync(…)` whose cancellation token fired, with the report so far ([`Error::report`]): every\n"
                            + "    /// item with its last status, those accepted but not yet final included, and the batch.\n"
                            + "    SyncCancelled(Box<crate::SyncReport>),\n"
                            + "    /// A `kb.ingestion().sync(…)` whose `confirm` declined the plan: the SDK's own `CANCELLED` (status 0), with the\n"
                            + "    /// report as planned ([`Error::report`]).\n    SyncDeclined(Box<rt::ApiError>, Box<crate::SyncReport>),\n" : "")
                    + "    /// A wait's time limit (`.timeout(…)`) passed; the watch it read is closed.\n    Timeout,\n}\n\n");
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
                    + api + "            Error::Api(e) => Some(e),\n" + (hasSync() ? "            Error::SyncDeclined(e, _) => Some(e),\n" : "") + "            _ => None,\n        }\n    }\n\n");
            w.l("    /// The HTTP status of a problem; 0 for a connection error or a problem the SDK raised.\n"
                    + "    pub fn status(&self) -> Option<u16> {\n        match self {\n            Error::Connection(e) => Some(e.status()),\n            Error::Timeout => Some(0),\n"
                    + "            other => other.api().map(|e| e.status),\n        }\n    }\n\n");
            w.l("    /// The stable product code of a problem, for example `NOT_FOUND`, or `CONNECTION_ERROR`.\n"
                    + "    pub fn code(&self) -> Option<&str> {\n        match self {\n            Error::Connection(e) => Some(e.code()),\n            Error::Timeout => Some(rt::WAIT_TIMEOUT),\n"
                    + "            other => other.api().map(|e| e.code.as_str()),\n        }\n    }\n\n");
            w.l("    /// The request's identifier; quote it to support.\n    pub fn request_id(&self) -> Option<&str> {\n"
                    + "        self.api().and_then(|e| e.request_id.as_deref())\n    }\n\n");
            w.l("    /// The model's name for the error shape, for example `NotFoundError`.\n    pub fn shape(&self) -> Option<&'static str> {\n"
                    + "        match self {\n" + shape + "            _ => None,\n        }\n    }\n\n");
            w.l("    /// Whether the thing is not there (404).\n    pub fn is_not_found(&self) -> bool {\n        self.status() == Some(404)\n    }\n\n");
            w.l("    /// Whether the call was cancelled: [`Error::Cancelled`]" + (hasSync() ? ", or a cancelled sync ([`Error::SyncCancelled`])" : "") + ".\n"
                    + "    pub fn is_cancelled(&self) -> bool {\n        matches!(self, Error::Cancelled" + (hasSync() ? " | Error::SyncCancelled(_)" : "") + ")\n    }\n\n");
            if (hasSync()) {
                w.l("    /// A cancelled sync's report so far: every item with its last status, those accepted but not yet final included,\n"
                        + "    /// and the batch with its counts. A declined `confirm` carries the report as planned. Only a sync stopped through\n"
                        + "    /// its cancellation token or a declined `confirm` returns an error to carry it: dropping the sync's future ends it\n"
                        + "    /// at once, with nothing returned.\n"
                        + "    pub fn report(&self) -> Option<&crate::SyncReport> {\n        match self {\n            Error::SyncCancelled(r) | Error::SyncDeclined(_, r) => Some(r),\n            _ => None,\n        }\n    }\n\n");
            }
            w.l("    /// Maps a runtime error to its typed variant, among `statuses` (an operation's modelled errors).\n"
                    + "    pub(crate) fn from_core(e: rt::Error, statuses: &[u16]) -> Self {\n        match e {\n"
                    + "            rt::Error::Api(a) if statuses.contains(&a.status) => match a.status {\n" + from
                    + "                _ => Error::Api(a),\n            },\n            rt::Error::Api(a) => Error::Api(a),\n"
                    + "            rt::Error::NotSupportedByServer(e) => Error::NotSupportedByServer(e),\n"
                    + "            rt::Error::Input(e) => Error::Input(e),\n            rt::Error::Auth(e) => Error::Auth(e),\n"
                    + "            rt::Error::Connection(e) => Error::Connection(e),\n            rt::Error::Timeout => Error::Timeout,\n"
                    + (hasSync() ? "            rt::Error::CancelledWith(p) => match p.0.downcast::<crate::SyncReport>() {\n"
                            + "                Ok(report) => Error::SyncCancelled(report),\n                Err(_) => Error::Cancelled,\n            },\n"
                            + "            rt::Error::ApiWith(a, p) => match p.0.downcast::<crate::SyncReport>() {\n"
                            + "                Ok(report) => Error::SyncDeclined(a, report),\n                Err(_) => Error::Api(a),\n            },\n" : "")
                    + "            _ => Error::Cancelled,\n        }\n    }\n}\n\n");
            List<String> all = new ArrayList<>();
            errorsByStatus.keySet().forEach(s -> all.add(String.valueOf(s)));
            w.l("impl From<rt::Error> for Error {\n    fn from(e: rt::Error) -> Self {\n        Error::from_core(e, &[" + String.join(", ", all) + "])\n    }\n}\n\n");
            StringBuilder shapes = new StringBuilder();
            errorsByStatus.forEach((st, e) -> shapes.append("    (").append(st).append(", ").append(Names.str(e.getId().getName())).append("),\n"));
            w.l("/// Every error shape in the model, by HTTP status: the class name telemetry reports as `error.type`.\n"
                    + "pub(crate) const ERROR_SHAPES: &[(u16, &str)] = &[\n" + shapes + "];\n\n");
            StringBuilder codes = new StringBuilder();
            errorsByStatus.forEach((st, e) -> e.findTrait(CaitlynTraits.ERROR_CODES).ifPresent(t -> t.toNode().expectArrayNode().getElements()
                    .forEach(c -> codes.append("    (").append(Names.str(c.expectStringNode().getValue())).append(", ").append(st).append("),\n"))));
            w.l("/// Every error code the model lists, with its HTTP status: a job that failed with a code is that status's variant.\n"
                    + "pub(crate) const ERROR_CODES: &[(&str, u16)] = &[\n" + codes + "];\n\n");
            w.l("impl std::fmt::Display for Error {\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n"
                    + "        match self {\n            Error::NotSupportedByServer(e) => e.fmt(f),\n            Error::Input(e) => e.fmt(f),\n"
                    + "            Error::Auth(e) => e.fmt(f),\n            Error::Connection(e) => e.fmt(f),\n"
                    + "            Error::Cancelled => f.write_str(\"caitlyn: the call was cancelled\"),\n"
                    + (hasSync() ? "            Error::SyncCancelled(_) => f.write_str(\"caitlyn: the sync was cancelled\"),\n" : "")
                    + "            Error::Timeout => f.write_str(\"caitlyn: the wait's time limit passed\"),\n"
                    + "            other => other.api().expect(\"a problem variant\").fmt(f),\n        }\n    }\n}\n\n");
            w.l("impl std::error::Error for Error {\n    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {\n        match self {\n"
                    + "            Error::Connection(e) => Some(e),\n"
                    + "            other => other.api().and_then(|e| e.source.as_deref()).map(|s| s as _),\n"
                    + "        }\n    }\n}\n");
        });
    }

    /** The model has ingestion batches, so the client has {@code kb.ingestion().sync}. */
    boolean hasSync() {
        return byName("CreateIngestionBatch").isPresent();
    }

    // ------------------------------------------------------------------ lib, Cargo.toml

    String title() {
        return service.getTrait(TitleTrait.class).map(TitleTrait::getValue).orElse("Caitlyn API");
    }

    private void lib() {
        RustSettings s = ctx.settings();
        StringBuilder out = new StringBuilder(RustWriter.HEADER);
        out.append(Names.innerDoc("The Rust SDK for the " + title() + ", generated from its Smithy model by caitlyn-rust-codegen, on the "
                + "hand-written runtime `" + s.coreCrate() + "`. Async on tokio, TLS through rustls, telemetry through `tracing`; it "
                + "reads no AWS configuration.\n\n"
                + "The client is a tree of scopes (PROTOCOL.md 10): `client.knowledge_base(id)` is a knowledge base, "
                + "`client.knowledge_bases().list()` lists them, and everything about one hangs off its scope. Making a scope sends "
                + "nothing; a call is sent when its request is awaited.\n\n"
                + "```no_run\n# async fn run() -> Result<(), caitlyn_sdk::Error> {\nuse caitlyn_sdk::{Auth, Client};\n\n"
                + "let client = Client::new(\"your-company.getcaitlyn.ai\", Auth::token(\"cait-pat-…\"))?;\n"
                + "let kb = client.knowledge_base(\"kb_123\");\n"
                + "let document = kb.documents().create(\"./leave-policy.pdf\").folder(\"/hr/\").wait().await?;\n"
                + "println!(\"{} {}\", document.id, document.status);\n"
                + "# Ok(())\n# }\n```"));
        out.append("#![forbid(unsafe_code)]\n\n");
        out.append("mod error;\nmod operations;\npub mod scope;\npub mod types;\n\n");
        out.append("pub use error::Error;\npub use operations::*;\npub use scope::{\n    BatchFiles, BatchUpload, BatchUploadRequest, Client, ClientBuilder, EstimateUploadRequest, IngestionProgress, LocalFile, SyncInput,\n    SyncItem, SyncPhase, SyncPlan, SyncReport,\n};\npub use types::*;\n");
        out.append("\npub use caitlyn_sdk_core::{\n    ApiError, Attachment, Auth, AuthError, AuthSession, AuthorizationUrl, AwsCredentialProvider, AwsCredentials, Call, CallOptions,\n"
                + "    Callback, CancellationToken, ConnectionError, Created, FieldError, InputError, Items, MemoryTokenStore, NotSupportedByServer,\n"
                + "    OAuthTokens, Pages, Propagator, Raw, ResponseMetadata, SigningAlgorithm, Started, Stream, TokenStore, UploadFile,\n"
                + "    WaitOptions, Waiting,\n};\n\n");
        out.append("/// The sign-in modes' option types.\npub mod auth {\n    pub use caitlyn_sdk_core::auth::*;\n    pub use caitlyn_sdk_core::aws::ProviderFn;\n}\n\n");
        out.append("/// This SDK's version.\npub const SDK_VERSION: &str = ").append(Names.str(s.version())).append(";\n\n");
        out.append("/// The Caitlyn release the SDK was generated from (the highest `@since` in the model), sent as `Caitlyn-Sdk-Model`.\n");
        out.append("pub const MODEL_VERSION: &str = ").append(Names.str(facts.apiVersion)).append(";\n");
        ctx.fileManifest().writeFile("src/lib.rs", out.toString());
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
                // The crate's crates.io page: the Rust SDK's README (rust/README.md), which cargo packages as README.md.
                + "homepage = \"https://build.caitlyn.ai/\"\nreadme = \"../README.md\"\nkeywords = [\"caitlyn\", \"sdk\", \"api\", \"ai\", \"agents\"]\n"
                + "categories = [\"api-bindings\", \"web-programming::http-client\"]\n\n"
                + "[dependencies]\n" + s.coreCrate() + " = " + core + "\n"
                + "serde = { version = \"1\", features = [\"derive\"] }\nserde_json = \"1\"\n"
                + "chrono = { version = \"0.4\", default-features = false, features = [\"std\", \"serde\"] }\n";
        ctx.fileManifest().writeFile("Cargo.toml", toml);
    }
}
