package ai.caitlyn.codegen.go;

import ai.caitlyn.codegen.model.CaitlynTraits;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.TreeSet;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.PaginationInfo;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.node.Node;
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
import software.amazon.smithy.model.traits.DocumentationTrait;
import software.amazon.smithy.model.traits.HttpErrorTrait;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.HttpResponseCodeTrait;
import software.amazon.smithy.model.traits.RetryableTrait;

/**
 * Writes everything that is not a shape: one api_<namespace>.go per namespace (Input types, operation
 * descriptors, request builders, response readers, methods, list iterators, streams, upload helpers and
 * waiters), client.go, version.go, options.go (a fixed file re-exporting the runtime's options), doc.go and
 * go.mod.
 */
final class ServiceGenerator {
    private static final ShapeId WAITABLE = ShapeId.from("smithy.waiters#waitable");

    private final GoContext ctx;
    private final Model model;
    private final ServiceShape service;
    private final ModelFacts facts;
    private final String core;
    private final Map<ShapeId, OperationInfo> ops = new LinkedHashMap<>();
    private final TreeMap<String, List<OperationInfo>> byNamespace = new TreeMap<>();

    ServiceGenerator(GoContext ctx, ServiceShape service) {
        this.ctx = ctx;
        this.model = ctx.model();
        this.service = service;
        this.facts = ctx.facts();
        this.core = ctx.settings().coreModule();
        for (OperationShape op : new TreeSet<>(TopDownIndex.of(model).getContainedOperations(service))) {
            if (CaitlynTraits.stability(op).equals("internal")) {
                continue;
            }
            OperationInfo info = new OperationInfo(model, service, op);
            ops.put(op.getId(), info);
            byNamespace.computeIfAbsent(info.namespace, k -> new ArrayList<>()).add(info);
        }
    }

    void run() {
        for (Map.Entry<String, List<OperationInfo>> ns : byNamespace.entrySet()) {
            String file = "api_" + Names.words(ns.getKey()).stream().reduce((a, b) -> a + "_" + b).orElseThrow() + ".go";
            ctx.writerDelegator().useFileWriter(file, "", w -> {
                for (OperationInfo op : ns.getValue()) {
                    operation(w, op);
                }
                uploadHelpers(w, ns.getValue());
            });
        }
        client();
        version();
        staticFiles();
    }

    private Shape target(MemberShape m) {
        return model.expectShape(m.getTarget());
    }

    private static String doc(Shape s) {
        return s.getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
    }

    // ------------------------------------------------------------------ one operation

    private void operation(GoWriter w, OperationInfo op) {
        w.imp("context").imp(core);
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
        waiters(w, op);
    }

    private String resultType(OperationInfo op) {
        return ctx.symbolProvider().toSymbol(op.output).getName();
    }

    /** "ctx context.Context, conversationID string, in *SendMessageInput". */
    private String params(OperationInfo op) {
        return "ctx context.Context, " + op.positionalParam().map(p -> p + " string, ").orElse("") + "in *" + op.inputType();
    }

    private String args(OperationInfo op, String inExpr) {
        return op.positionalParam().map(p -> p + ", ").orElse("") + inExpr;
    }

    private String errorsDoc(OperationInfo op) {
        List<String> parts = new ArrayList<>();
        for (StructureShape e : OperationIndex.of(model).getErrors(service, op.op)) {
            parts.add("*" + ctx.symbolProvider().toSymbol(e).getName() + " (" + e.expectTrait(HttpErrorTrait.class).getCode() + ")");
        }
        return parts.isEmpty() ? "" : "Errors: " + String.join(", ", parts) + "; another status the API models has its own type too (*NotFoundError for 404), and any other status is an *Error.";
    }

    private String methodDoc(OperationInfo op, String methodName, String extra) {
        StringBuilder text = new StringBuilder(doc(op.op).strip());
        if (!extra.isEmpty()) {
            text.append("\n\n").append(extra);
        }
        String errs = errorsDoc(op);
        if (!errs.isEmpty()) {
            text.append("\n\n").append(errs);
        }
        op.since.ifPresent(s -> text.append("\n\nSince Caitlyn ").append(s).append(op.stability.equals("ga") ? "." : "; " + op.stability + "."));
        return Names.doc(methodName, text.toString(), true, "");
    }

    private void inputType(GoWriter w, OperationInfo op) {
        String name = op.inputType();
        StringBuilder extra = new StringBuilder();
        op.positional.ifPresent(p -> extra.append(" ").append(p.member().getMemberName()).append(" is a parameter of the method."));
        op.ifMatch.ifPresent(p -> extra.append(" If-Match is the call option WithIfMatch").append(p.member().isRequired() ? " (required)." : "."));
        op.idempotency.ifPresent(p -> extra.append(" The idempotency key is generated, or set with WithIdempotencyKey."));
        w.l(Names.comment(name + " is the input of " + op.namespace + "." + op.method + "." + extra, ""));
        w.l("type " + name + " struct {\n");
        for (OperationInfo.Param p : op.fields) {
            MemberShape m = p.member();
            if (p.location() == HttpBinding.Location.PAYLOAD) {
                throw new CodegenException(m.getId() + ": @httpPayload inputs are not supported yet");
            }
            String text = m.getMemberTrait(model, DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
            if (!text.isEmpty()) {
                w.l(Names.comment(text, "\t"));
            }
            String where = switch (p.location()) {
                case LABEL -> "Sent in the path.";
                case QUERY -> "Sent as the query parameter " + p.wire() + ".";
                case HEADER -> "Sent as the " + p.wire() + " header.";
                default -> "";
            };
            CaitlynTraits.since(m).ifPresent(s -> w.l("\t// Since Caitlyn " + s + ": refused before sending to an older server.\n"));
            if (!where.isEmpty()) {
                w.l("\t// " + where + "\n");
            }
            String tag = p.location() == HttpBinding.Location.DOCUMENT
                    ? p.wire() + (m.isRequired() ? "" : ",omitempty") : "-";
            w.l("\t" + p.field() + " " + ctx.types().member(m, w) + " `json:\"" + tag + "\"`\n");
        }
        w.l("}\n\n");
    }

    private void errorTable(GoWriter w, OperationInfo op) {
        w.l("func errors" + op.name + "(status int, e *core.APIError) error {\n\tswitch status {\n");
        for (StructureShape e : serviceErrors()) {
            w.l("\tcase " + e.expectTrait(HttpErrorTrait.class).getCode() + ":\n\t\treturn &"
                    + ctx.symbolProvider().toSymbol(e).getName() + "{e}\n");
        }
        w.l("\t}\n\treturn e\n}\n\n");
    }

    private void descriptor(GoWriter w, OperationInfo op) {
        List<String> retryable = new ArrayList<>();
        for (StructureShape e : OperationIndex.of(model).getErrors(service, op.op)) {
            if (e.hasTrait(RetryableTrait.class)) {
                retryable.add(String.valueOf(e.expectTrait(HttpErrorTrait.class).getCode()));
            }
        }
        StringBuilder d = new StringBuilder("var op" + op.name + " = &core.Operation{\n");
        d.append("\tName: ").append(Names.str(op.name)).append(",\n");
        d.append("\tMethod: ").append(Names.str(op.http.getMethod())).append(",\n");
        op.since.ifPresent(s -> d.append("\tSince: ").append(Names.str(s)).append(",\n"));
        if (op.retrySafe) {
            d.append("\tRetrySafe: true,\n");
        }
        if (op.kind == OperationInfo.Kind.STREAM) {
            d.append("\tSSE: true,\n");
        }
        op.idempotency.ifPresent(p -> d.append("\tIdempotencyHeader: ").append(Names.str(p.wire())).append(",\n"));
        op.ifMatch.filter(p -> p.member().isRequired()).ifPresent(p -> d.append("\tIfMatchRequired: true,\n"));
        if (!retryable.isEmpty()) {
            d.append("\tRetryable: []int{").append(String.join(", ", retryable)).append("},\n");
        }
        d.append("\tErrors: errors").append(op.name).append(",\n}\n\n");
        w.l(d.toString());
    }

    // ------------------------------------------------------------------ requests

    /** Go expression for a member's value in the builder: the positional parameter or in.<Field>. */
    private String valueExpr(OperationInfo op, OperationInfo.Param p) {
        if (op.positional.isPresent() && op.positional.get().member().equals(p.member())) {
            return op.positionalParam().orElseThrow();
        }
        return "in." + p.field();
    }

    /** Formats a scalar of the target's type as a string. v is a value (not a pointer). */
    private String format(Shape target, String v, GoWriter w, MemberShape m) {
        return switch (target.getType()) {
            case STRING -> v;
            case ENUM -> "string(" + v + ")";
            case BYTE, SHORT, INTEGER, LONG -> {
                w.imp("strconv");
                yield "strconv.FormatInt(int64(" + v + "), 10)";
            }
            case BOOLEAN -> {
                w.imp("strconv");
                yield "strconv.FormatBool(" + v + ")";
            }
            case TIMESTAMP -> "core.FormatTime(" + v + ")";
            default -> throw new CodegenException(m.getId() + ": " + target.getType() + " is not supported in a label, query or header yet");
        };
    }

    private boolean isPointer(OperationInfo.Param p) {
        return !p.member().isRequired() && GoTypes.pointable(target(p.member()));
    }

    private String isSet(OperationInfo op, OperationInfo.Param p) {
        if (p.member().isRequired()) {
            return "true";
        }
        return GoTypes.pointable(target(p.member())) ? valueExpr(op, p) + " != nil" : "len(" + valueExpr(op, p) + ") > 0";
    }

    private void builder(GoWriter w, OperationInfo op) {
        String in = op.inputType();
        w.l("func build" + op.name + "(" + op.positionalParam().map(p -> p + " string, ").orElse("") + "in *" + in + ") (*core.Request, error) {\n");
        // Required labels must be non-empty.
        for (OperationInfo.Param p : op.all) {
            if (p.location() == HttpBinding.Location.LABEL && target(p.member()).isStringShape()) {
                w.l("\tif " + valueExpr(op, p) + " == \"\" {\n\t\treturn nil, core.MissingInput(" + Names.str(op.name) + ", "
                        + Names.str(p.member().getMemberName()) + ")\n\t}\n");
            }
        }
        StringBuilder path = new StringBuilder();
        StringBuilder literal = new StringBuilder();
        for (SmithyPattern.Segment seg : op.http.getUri().getSegments()) {
            literal.append('/');
            if (seg.isLabel()) {
                if (seg.isGreedyLabel()) {
                    throw new CodegenException(op.op.getId() + ": greedy labels are not supported yet");
                }
                OperationInfo.Param p = op.param(seg.getContent()).orElseThrow();
                path.append(path.length() > 0 ? " + " : "").append(Names.str(literal.toString())).append(" + core.PathLabel(")
                        .append(format(target(p.member()), valueExpr(op, p), w, p.member())).append(")");
                literal.setLength(0);
            } else {
                literal.append(seg.getContent());
            }
        }
        if (literal.length() > 0 || path.length() == 0) {
            path.append(path.length() > 0 ? " + " : "").append(Names.str(literal.toString()));
        }
        if (op.http.getUri().getQueryLiterals().size() > 0) {
            throw new CodegenException(op.op.getId() + ": query literals in @http are not supported yet");
        }
        w.l("\treq := core.NewRequest(" + path + ")\n");
        for (OperationInfo.Param p : op.fields) {
            if (p.location() != HttpBinding.Location.QUERY && p.location() != HttpBinding.Location.HEADER) {
                continue;
            }
            String set = p.location() == HttpBinding.Location.QUERY ? "req.Query.Add(" : "req.Header.Add(";
            Shape t = target(p.member());
            if (t instanceof ListShape list) {
                Shape item = model.expectShape(list.getMember().getTarget());
                w.l("\tfor _, v := range " + valueExpr(op, p) + " {\n\t\t" + set + Names.str(p.wire()) + ", "
                        + format(item, "v", w, p.member()) + ")\n\t}\n");
            } else if (isPointer(p)) {
                w.l("\tif " + valueExpr(op, p) + " != nil {\n\t\t" + set + Names.str(p.wire()) + ", "
                        + format(t, "*" + valueExpr(op, p), w, p.member()) + ")\n\t}\n");
            } else {
                w.l("\t" + set + Names.str(p.wire()) + ", " + format(t, valueExpr(op, p), w, p.member()) + ")\n");
            }
        }
        for (OperationInfo.Param p : op.all) {
            Optional<String> since = CaitlynTraits.since(p.member());
            if (since.isPresent() && op.since.map(s -> ModelFacts.compareVersions(since.get(), s) > 0).orElse(true)) {
                w.l("\tif " + isSet(op, p) + " {\n\t\treq.Set = append(req.Set, core.Since{Member: " + Names.str(p.member().getMemberName())
                        + ", Version: " + Names.str(since.get()) + "})\n\t}\n");
            }
        }
        if (op.all.stream().anyMatch(p -> p.location() == HttpBinding.Location.DOCUMENT)) {
            w.l("\tif err := req.JSONBody(in); err != nil {\n\t\treturn nil, err\n\t}\n");
        }
        w.l("\treturn req, nil\n}\n\n");
    }

    // ------------------------------------------------------------------ responses

    private void reader(GoWriter w, OperationInfo op) {
        String result = resultType(op);
        Map<String, HttpBinding> bindings = HttpBindingIndex.of(model).getResponseBindings(op.op);
        boolean body = false;
        w.l("func read" + op.name + "(resp *core.Response) (*" + result + ", error) {\n\tout := &" + result + "{}\n");
        for (HttpBinding b : bindings.values()) {
            if (b.getLocation() == HttpBinding.Location.DOCUMENT) {
                body = true;
            } else if (b.getLocation() == HttpBinding.Location.PAYLOAD || b.getMember().hasTrait(HttpResponseCodeTrait.class)
                    || b.getLocation() == HttpBinding.Location.PREFIX_HEADERS) {
                throw new CodegenException(b.getMember().getId() + ": " + b.getLocation() + " output bindings are not supported yet");
            }
        }
        if (body) {
            w.l("\tif err := resp.DecodeJSON(out); err != nil {\n\t\treturn nil, err\n\t}\n");
        } else {
            w.l("\tresp.Body.Close()\n");
        }
        for (HttpBinding b : bindings.values()) {
            if (b.getLocation() != HttpBinding.Location.HEADER) {
                continue;
            }
            MemberShape m = b.getMember();
            if (!target(m).isStringShape()) {
                throw new CodegenException(m.getId() + ": non-string response headers are not supported yet");
            }
            String fn = m.isRequired() ? "HeaderValue" : "HeaderPtr";
            w.l("\tout." + Names.exported(m.getMemberName()) + " = resp." + fn + "(" + Names.str(b.getLocationName()) + ")\n");
        }
        w.l("\tout.metadata = resp.Metadata()\n");
        w.l("\treturn out, nil\n}\n\n");
    }

    private String nilInput(OperationInfo op) {
        return "\tif in == nil {\n\t\tin = &" + op.inputType() + "{}\n\t}\n";
    }

    private void unary(GoWriter w, OperationInfo op) {
        String result = resultType(op);
        w.l(methodDoc(op, op.method, ""));
        w.l("func (c *" + op.namespaceType + ") " + op.method + "(" + params(op) + ", opts ...CallOption) (*" + result + ", error) {\n");
        w.l(nilInput(op));
        w.l("\treq, err := build" + op.name + "(" + args(op, "in") + ")\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tresp, err := c.c.core.Do(ctx, op" + op.name + ", req, opts)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\treturn read" + op.name + "(resp)\n}\n\n");
    }

    private void paginated(GoWriter w, OperationInfo op) {
        w.imp("iter");
        PaginationInfo pi = op.pagination.orElseThrow();
        if (pi.getOutputTokenMemberPath().size() != 1 || pi.getItemsMemberPath().size() != 1) {
            throw new CodegenException(op.op.getId() + ": nested pagination paths are not supported yet");
        }
        MemberShape items = pi.getItemsMemberPath().get(0);
        MemberShape next = pi.getOutputTokenMemberPath().get(0);
        String itemType = ctx.types().base(model.expectShape(((ListShape) target(items)).getMember().getTarget()), w);
        String page = resultType(op);
        String cursorField = Names.exported(pi.getInputTokenMember().getMemberName());
        if (pi.getInputTokenMember().isRequired() || next.isRequired()) {
            throw new CodegenException(op.op.getId() + ": required pagination tokens are not supported yet");
        }
        w.l(methodDoc(op, op.method, "It yields every item, fetching pages as needed; " + op.method + "Pages yields whole pages."));
        w.l("func (c *" + op.namespaceType + ") " + op.method + "(" + params(op) + ", opts ...CallOption) iter.Seq2[" + itemType + ", error] {\n");
        w.l("\treturn core.Items(c." + op.method + "Pages(ctx, " + args(op, "in") + ", opts...), func(p *" + page + ") []" + itemType
                + " { return p." + Names.exported(items.getMemberName()) + " })\n}\n\n");
        w.l(Names.comment(op.method + "Pages yields the pages of " + op.namespace + "." + op.method + ", from in." + cursorField
                + " (normally unset) to the last page.", ""));
        w.l("func (c *" + op.namespaceType + ") " + op.method + "Pages(" + params(op) + ", opts ...CallOption) iter.Seq2[*" + page + ", error] {\n");
        w.l(nilInput(op));
        w.l("\treturn core.Pages(ctx, in." + cursorField + ", func(ctx context.Context, cursor *string) (*" + page + ", *string, error) {\n");
        w.l("\t\tpage := *in\n\t\tpage." + cursorField + " = cursor\n");
        w.l("\t\treq, err := build" + op.name + "(" + args(op, "&page") + ")\n\t\tif err != nil {\n\t\t\treturn nil, nil, err\n\t\t}\n");
        w.l("\t\tresp, err := c.c.core.Do(ctx, op" + op.name + ", req, opts)\n\t\tif err != nil {\n\t\t\treturn nil, nil, err\n\t\t}\n");
        w.l("\t\tout, err := read" + op.name + "(resp)\n\t\tif err != nil {\n\t\t\treturn nil, nil, err\n\t\t}\n");
        w.l("\t\treturn out, out." + Names.exported(next.getMemberName()) + ", nil\n\t})\n}\n\n");
    }

    // ------------------------------------------------------------------ streams

    private final java.util.Set<String> emittedFinals = new java.util.HashSet<>();

    private record StreamTypes(String union, String finalType, String finalFn) {}

    private StreamTypes streamTypes(GoWriter w, OperationInfo op) {
        ObjectNode sse = op.sse.orElseThrow();
        UnionShape union = model.expectShape(ShapeId.from(sse.expectStringMember("events").getValue()), UnionShape.class);
        String u = Names.exported(union.getId().getName());
        Optional<String> fin = sse.getStringMember("final").map(s -> s.getValue());
        if (fin.isEmpty()) {
            return new StreamTypes(u, "struct{}", "nil");
        }
        MemberShape fm = union.getMember(fin.get()).orElseThrow(() -> new CodegenException(op.op.getId() + ": no union member " + fin.get()));
        StructureShape ft = model.expectShape(fm.getTarget(), StructureShape.class);
        if (ft.getAllMembers().size() != 1) {
            throw new CodegenException(ft.getId() + ": the final event must have exactly one member (PROTOCOL.md lint rule 4)");
        }
        MemberShape only = ft.getAllMembers().values().iterator().next();
        String evType = ctx.symbolProvider().toSymbol(ft).getName();
        String finalType = ctx.types().base(target(only), w);
        String fn = "final" + u + evType;
        String field = Names.exported(only.getMemberName());
        String ret = only.isRequired() || !GoTypes.pointable(target(only)) ? "&v." + field : "v." + field;
        if (emittedFinals.add(fn)) {
            w.l("func " + fn + "(ev " + u + ") (*" + finalType + ", bool) {\n\tif v, ok := ev.(*" + evType + "); ok {\n\t\treturn "
                    + ret + ", true\n\t}\n\treturn nil, false\n}\n\n");
        }
        return new StreamTypes(u, finalType, fn);
    }

    private final Map<String, String> streamAliases = new LinkedHashMap<>();

    private void stream(GoWriter w, OperationInfo op) {
        StreamTypes st = streamTypes(w, op);
        String alias = st.union() + "Stream";
        String target = "core.Stream[" + st.union() + ", " + st.finalType() + "]";
        String prev = streamAliases.putIfAbsent(alias, target);
        if (prev == null) {
            w.l(Names.comment(alias + " is a stream of " + st.union() + " events. Range over Events, then call FinalMessage"
                    + (st.finalType().equals("struct{}") ? "" : " for the *" + st.finalType())
                    + "; always Close it. A dropped connection is resumed with Last-Event-ID where the model allows.", ""));
            w.l("type " + alias + " = " + target + "\n\n");
        } else if (!prev.equals(target)) {
            throw new CodegenException(op.op.getId() + ": two streams of " + st.union() + " with different final events");
        }
        ObjectNode sse = op.sse.orElseThrow();
        String resume = "nil";
        Optional<String> resumeWith = sse.getStringMember("resumeWith").map(s -> s.getValue());
        if (resumeWith.isPresent()) {
            OperationInfo r = ops.get(ShapeId.from(resumeWith.get()));
            if (r == null) {
                throw new CodegenException(op.op.getId() + ": resumeWith " + resumeWith.get() + " is not a generated operation");
            }
            StringBuilder b = new StringBuilder("func(ctx context.Context, lastEventID string) (*core.Response, error) {\n");
            b.append("\t\t\trin := &").append(r.inputType()).append("{}\n");
            String positionalArg = "";
            boolean lastSet = false;
            for (OperationInfo.Param rp : r.all) {
                String member = rp.member().getMemberName();
                if (rp.location() == HttpBinding.Location.HEADER && rp.wire().equalsIgnoreCase("Last-Event-ID")) {
                    b.append("\t\t\trin.").append(rp.field()).append(" = ").append(isPointer(rp) ? "&lastEventID" : "lastEventID").append("\n");
                    lastSet = true;
                    continue;
                }
                if (rp.location() != HttpBinding.Location.LABEL) {
                    continue;
                }
                OperationInfo.Param src = op.param(member).orElseThrow(() ->
                        new CodegenException(r.op.getId() + ": label " + member + " has no member of the same name in " + op.op.getId()));
                String value = valueExpr(op, src);
                if (r.positional.isPresent() && r.positional.get().member().getMemberName().equals(member)) {
                    positionalArg = value + ", ";
                } else {
                    b.append("\t\t\trin.").append(rp.field()).append(" = ").append(value).append("\n");
                }
            }
            if (!lastSet) {
                throw new CodegenException(r.op.getId() + ": a resumeWith operation needs a Last-Event-ID header member");
            }
            b.append("\t\t\trreq, err := build").append(r.name).append("(").append(positionalArg).append("rin)\n");
            b.append("\t\t\tif err != nil {\n\t\t\t\treturn nil, err\n\t\t\t}\n");
            b.append("\t\t\treturn c.c.core.Do(ctx, op").append(r.name).append(", rreq, nil)\n\t\t}");
            resume = b.toString();
        }
        w.l(methodDoc(op, op.method, "The error for a failed request is returned at once; errors during the stream (an error event, "
                + "a connection that could not be resumed, cancellation) end Events with that error."));
        w.l("func (c *" + op.namespaceType + ") " + op.method + "(" + params(op) + ", opts ...CallOption) (*" + alias + ", error) {\n");
        w.l(nilInput(op));
        w.l("\treq, err := build" + op.name + "(" + args(op, "in") + ")\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tresp, err := c.c.core.Do(ctx, op" + op.name + ", req, opts)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\treturn core.OpenStream(ctx, resp, core.StreamSpec[" + st.union() + ", " + st.finalType() + "]{\n");
        w.l("\t\tDecode: decode" + st.union() + "(errors" + op.name + "),\n\t\tFinal: " + st.finalFn() + ",\n\t\tResume: " + resume + ",\n\t}), nil\n}\n\n");
    }

    // ------------------------------------------------------------------ uploads (PROTOCOL.md 10)

    private void uploadHelpers(GoWriter w, List<OperationInfo> nsOps) {
        for (OperationInfo op : nsOps) {
            if (op.op.findTrait(CaitlynTraits.PRESIGNED_UPLOAD).isPresent()) {
                for (String m : List.of("fileName", "contentType", "byteSize", "sha256")) {
                    op.param(m).orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs input member " + m));
                }
                for (String m : List.of("uploadUrl", "uploadMethod", "requiredHeaders")) {
                    op.output.getMember(m).orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs output member " + m));
                }
                if (nsOps.stream().anyMatch(o -> o.method.equals("Create"))) {
                    throw new CodegenException(op.op.getId() + ": " + op.namespace + " already has Create; the upload helper needs the name");
                }
                String result = resultType(op);
                w.l(Names.comment("Create uploads a file: it computes the SHA-256, reserves a slot with " + op.method
                        + ", then sends the bytes to the presigned URL with exactly the required headers (no Caitlyn credentials go there). "
                        + "Bytes that cannot be sent give an *Error with the code UPLOAD_PUT_FAILED.", ""));
                w.l("func (c *" + op.namespaceType + ") Create(ctx context.Context, file *UploadFile, opts ...CallOption) (*" + result + ", error) {\n");
                w.l("\tup, err := c." + op.method + "(ctx, &" + op.inputType() + "{" + Names.exported("fileName") + ": file.Name, "
                        + Names.exported("contentType") + ": file.ContentType, " + Names.exported("byteSize") + ": int64(len(file.Data)), "
                        + Names.exported("sha256") + ": file.SHA256()}, opts...)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
                w.l("\tif err := c.c.core.PutPresigned(ctx, up." + Names.exported("uploadMethod") + ", up." + Names.exported("uploadUrl")
                        + ", up." + Names.exported("requiredHeaders") + ", file.Data); err != nil {\n\t\treturn nil, err\n\t}\n\treturn up, nil\n}\n\n");
            }
            Optional<String> target = CaitlynTraits.stringMember(op.op, CaitlynTraits.UPLOAD_TARGET, "member");
            if (target.isPresent()) {
                OperationInfo presigned = ops.values().stream().filter(o -> o.op.findTrait(CaitlynTraits.PRESIGNED_UPLOAD).isPresent())
                        .findFirst().orElseThrow(() -> new CodegenException(op.op.getId() + ": @uploadTarget needs a @presignedUpload operation"));
                OperationInfo.Param p = op.param(target.get()).orElseThrow();
                String result = resultType(op);
                w.l(Names.comment("Upload uploads file (as " + presigned.namespace + ".Create does) and then calls " + op.method
                        + " with " + p.field() + " set to the upload's ID. Other fields come from in.", ""));
                w.l("func (c *" + op.namespaceType + ") Upload(ctx context.Context, " + op.positionalParam().map(x -> x + " string, ").orElse("")
                        + "file *UploadFile, in *" + op.inputType() + ", opts ...CallOption) (*" + result + ", error) {\n");
                w.l(nilInput(op));
                w.l("\tup, err := c.c." + presigned.namespace + ".Create(ctx, file, opts...)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
                w.l("\tnext := *in\n\tnext." + p.field() + " = up." + Names.exported("id") + "\n");
                w.l("\treturn c." + op.method + "(ctx, " + args(op, "&next") + ", opts...)\n}\n\n");
            }
        }
    }

    // ------------------------------------------------------------------ waiters (smithy.waiters#waitable)

    private void waiters(GoWriter w, OperationInfo op) {
        Optional<Node> trait = op.op.findTrait(WAITABLE).map(t -> t.toNode());
        if (trait.isEmpty()) {
            return;
        }
        if (op.kind != OperationInfo.Kind.UNARY) {
            throw new CodegenException(op.op.getId() + ": waiters on list or stream operations are not supported yet");
        }
        w.imp("time");
        String result = resultType(op);
        for (Map.Entry<String, Node> e : new TreeMap<>(trait.get().expectObjectNode().getStringMap()).entrySet()) {
            String name = e.getKey();
            ObjectNode waiter = e.getValue().expectObjectNode();
            int min = waiter.getNumberMemberOrDefault("minDelay", 2).intValue();
            int max = waiter.getNumberMemberOrDefault("maxDelay", 120).intValue();
            String text = waiter.getStringMemberOrDefault("documentation", "Waits for " + name + ".");
            String accept = "accept" + name;
            w.l(Names.doc("WaitUntil" + name, text + "\n\nIt polls " + op.namespace + "." + op.method
                    + " (first at once, then every " + min + " to " + max + " seconds) until a success state, a failure state "
                    + "(a *WaiterError), or the time limit (WithMaxWait, default 5 minutes, or the context's deadline).", true, ""));
            w.l("func (c *" + op.namespaceType + ") WaitUntil" + name + "(" + params(op) + ", opts ...WaiterOption) (*" + result + ", error) {\n");
            w.l("\treturn core.Wait(ctx, " + Names.str(name) + ", " + min + "*time.Second, " + max + "*time.Second, opts,\n");
            w.l("\t\tfunc(ctx context.Context) (*" + result + ", error) { return c." + op.method + "(ctx, " + args(op, "in") + ") },\n\t\t" + accept + ")\n}\n\n");
            StringBuilder acc = new StringBuilder("func " + accept + "(out *" + result + ", err error) core.WaitState {\n");
            StringBuilder preds = new StringBuilder();
            int i = 0;
            for (Node a : waiter.expectArrayMember("acceptors").getElements()) {
                ObjectNode acceptor = a.expectObjectNode();
                String state = switch (acceptor.expectStringMember("state").getValue()) {
                    case "success" -> "core.WaitSuccess";
                    case "failure" -> "core.WaitFailure";
                    case "retry" -> "core.WaitRetry";
                    default -> throw new CodegenException(op.op.getId() + ": unknown waiter state");
                };
                ObjectNode matcher = acceptor.expectObjectMember("matcher");
                String cond;
                if (matcher.getBooleanMember("success").isPresent()) {
                    cond = matcher.expectBooleanMember("success").getValue() ? "err == nil" : "err != nil";
                } else if (matcher.getStringMember("errorType").isPresent()) {
                    w.imp("errors");
                    String type = matcher.expectStringMember("errorType").getValue();
                    StructureShape err = OperationIndex.of(model).getErrors(service, op.op).stream()
                            .filter(s -> s.getId().getName().equals(type)).findFirst()
                            .orElseThrow(() -> new CodegenException(op.op.getId() + ": waiter errorType " + type + " is not an error of the operation"));
                    String var = "e" + i;
                    acc.append("\tvar " + var + " *" + ctx.symbolProvider().toSymbol(err).getName() + "\n");
                    cond = "errors.As(err, &" + var + ")";
                } else if (matcher.getObjectMember("output").isPresent()) {
                    ObjectNode m = matcher.expectObjectMember("output");
                    String fn = accept + "Path" + i;
                    preds.append(pathPredicate(w, fn, op.output, result, m.expectStringMember("path").getValue(),
                            m.expectStringMember("comparator").getValue(), m.expectStringMember("expected").getValue(), op));
                    cond = "err == nil && " + fn + "(out)";
                } else {
                    throw new CodegenException(op.op.getId() + ": only success, errorType and output waiter matchers are supported yet");
                }
                acc.append("\tif " + cond + " {\n\t\treturn " + state + "\n\t}\n");
                i++;
            }
            acc.append("\tif err != nil {\n\t\treturn core.WaitFailure\n\t}\n\treturn core.WaitRetry\n}\n\n");
            w.l(acc.toString()).l(preds.toString());
        }
    }

    /**
     * Compiles a waiter's JMESPath to Go: field chains ("a.b.c") with at most one list projection
     * ("a.list[].c"), checked against the model so a wrong path fails generation, not a wait.
     */
    private String pathPredicate(GoWriter w, String fn, StructureShape root, String rootType, String path, String comparator,
                               String expected, OperationInfo op) {
        if (!path.matches("[A-Za-z0-9_]+(\\[\\])?(\\.[A-Za-z0-9_]+(\\[\\])?)*") || path.chars().filter(ch -> ch == '[').count() > 1) {
            throw new CodegenException(op.op.getId() + ": waiter path " + path + " uses JMESPath beyond field chains and one [] projection");
        }
        StringBuilder body = new StringBuilder();
        StringBuilder after = new StringBuilder();
        boolean projected = false;
        String var = "out";
        Shape current = root;
        int n = 0;
        String indent = "\t";
        for (String raw : path.split("\\.")) {
            boolean flatten = raw.endsWith("[]");
            String seg = flatten ? raw.substring(0, raw.length() - 2) : raw;
            if (!(current instanceof StructureShape s)) {
                throw new CodegenException(op.op.getId() + ": waiter path " + path + " walks into a non-structure");
            }
            MemberShape m = s.getMember(seg).orElseThrow(() -> new CodegenException(op.op.getId() + ": waiter path " + path + ": no member " + seg));
            Shape t = target(m);
            String next = "v" + (++n);
            body.append(indent).append(next).append(" := ").append(var).append(".").append(Names.exported(m.getMemberName())).append("\n");
            boolean pointer = !m.isRequired() && GoTypes.pointable(t);
            if (pointer) {
                body.append(indent).append("if ").append(next).append(" == nil {\n").append(indent)
                        .append(projected ? "\tcontinue\n" : "\treturn false\n").append(indent).append("}\n");
            }
            var = next;
            current = t;
            if (flatten) {
                if (!(t instanceof ListShape list)) {
                    throw new CodegenException(op.op.getId() + ": waiter path " + path + ": [] on a non-list");
                }
                body.append(indent).append("var vals []string\n");
                body.append(indent).append("for _, it := range ").append(var).append(" {\n");
                indent = "\t\t";
                var = "it";
                current = model.expectShape(list.getMember().getTarget());
                projected = true;
                after.append("\t}\n");
            }
            if (pointer && !(t instanceof StructureShape) && !flatten) {
                var = "*" + var;
            }
        }
        String leaf;
        switch (current.getType()) {
            case STRING -> leaf = var;
            case ENUM -> leaf = "string(" + var + ")";
            case BOOLEAN -> leaf = "strconv.FormatBool(" + var + ")";
            default -> throw new CodegenException(op.op.getId() + ": waiter path " + path + " ends on " + current.getType());
        }
        if (current.isBooleanShape()) {
            w.imp("strconv");
        }
        StringBuilder out = new StringBuilder("func " + fn + "(out *" + rootType + ") bool {\n").append(body);
        String exp = Names.str(expected);
        if (projected) {
            if (!comparator.equals("allStringEquals") && !comparator.equals("anyStringEquals")) {
                throw new CodegenException(op.op.getId() + ": comparator " + comparator + " on a projection");
            }
            out.append(indent).append("vals = append(vals, ").append(leaf).append(")\n").append(after);
            if (comparator.equals("anyStringEquals")) {
                out.append("\tfor _, v := range vals {\n\t\tif v == ").append(exp).append(" {\n\t\t\treturn true\n\t\t}\n\t}\n\treturn false\n}\n\n");
            } else {
                out.append("\tif len(vals) == 0 {\n\t\treturn false\n\t}\n\tfor _, v := range vals {\n\t\tif v != ").append(exp)
                        .append(" {\n\t\t\treturn false\n\t\t}\n\t}\n\treturn true\n}\n\n");
            }
        } else {
            if (!comparator.equals("stringEquals") && !comparator.equals("booleanEquals")) {
                throw new CodegenException(op.op.getId() + ": comparator " + comparator + " without a projection");
            }
            out.append("\treturn ").append(leaf).append(" == ").append(exp).append("\n}\n\n");
        }
        return out.toString();
    }

    // ------------------------------------------------------------------ client, version, fixed files

    private void client() {
        ctx.writerDelegator().useFileWriter("client.go", "", w -> {
            w.imp(core);
            String title = service.getTrait(software.amazon.smithy.model.traits.TitleTrait.class).map(t -> t.getValue()).orElse("Caitlyn API");
            w.l(Names.comment("Client is the " + title + " client. Create one with NewClient and share it: it is safe for concurrent use. "
                    + "Operations are grouped by resource, for example client." + byNamespace.firstKey() + "."
                    + byNamespace.firstEntry().getValue().get(0).method + ".", ""));
            w.l("type Client struct {\n");
            for (String ns : byNamespace.keySet()) {
                w.l("\t" + ns + " *" + ns + "Client\n");
            }
            w.l("\n\tcore *core.Client\n}\n\n");
            w.l(Names.comment("NewClient returns a client for workspace (for example \"your-company.getcaitlyn.ai\"), authenticated by auth "
                    + "(for example caitlyn.Token(\"cait-pat-…\") or caitlyn.ClientCredentials{…}). The workspace sets the endpoint and the token audience, "
                    + "https://<workspace>/api. Options set the endpoint, the HTTP client, retries and telemetry; "
                    + "nothing is read from the environment, except by caitlyn.AWSIAM sign-in.", ""));
            w.l("func NewClient(workspace string, auth Auth, opts ...Option) (*Client, error) {\n");
            w.l("\tcc, err := core.NewClient(core.SDKInfo{Version: SDKVersion, ModelVersion: ModelVersion}, workspace, auth, opts...)\n");
            w.l("\tif err != nil {\n\t\treturn nil, err\n\t}\n\tc := &Client{core: cc}\n");
            for (String ns : byNamespace.keySet()) {
                w.l("\tc." + ns + " = &" + ns + "Client{c: c}\n");
            }
            w.l("\treturn c, nil\n}\n\n");
            w.l("// ServerVersion is the latest Caitlyn-Api-Version the client has seen, or \"\" before any response.\n");
            w.l("func (c *Client) ServerVersion() string { return c.core.ServerVersion() }\n\n");
            w.l("// Endpoint is the base URL requests are sent to: https://<workspace>/api, or the WithEndpoint value.\n");
            w.l("func (c *Client) Endpoint() string { return c.core.Endpoint() }\n\n");
            w.l("// Auth is the client's sign-in: its mode and token, and the OAuth mode's steps (AuthorizationURL,\n");
            w.l("// HandleCallback, SignOut).\n");
            w.l("func (c *Client) Auth() *AuthSession { return c.core.Auth() }\n\n");
            for (Map.Entry<String, List<OperationInfo>> e : byNamespace.entrySet()) {
                List<String> methods = new ArrayList<>();
                for (OperationInfo o : e.getValue()) {
                    methods.add(o.method);
                }
                w.l(Names.comment(e.getKey() + "Client holds the " + Names.lowerFirst(e.getKey()) + " operations (" + String.join(", ", methods)
                        + "). Use Client." + e.getKey() + ".", ""));
                w.l("type " + e.getKey() + "Client struct{ c *Client }\n\n");
            }
        });
    }

    private void version() {
        ctx.writerDelegator().useFileWriter("version.go", "", w -> {
            w.l("// SDKVersion is this SDK's version.\nconst SDKVersion = " + Names.str(ctx.settings().version()) + "\n\n");
            w.l("// ModelVersion is the Caitlyn release the SDK was generated from (the highest @since in the model), sent as Caitlyn-Sdk-Model.\n");
            w.l("const ModelVersion = " + Names.str(facts.apiVersion) + "\n");
        });
    }

    private void staticFiles() {
        GoSettings s = ctx.settings();
        String options = resource("options.go.tmpl").replace("{{CORE}}", s.coreModule()).replace("{{PACKAGE}}", s.packageName());
        ctx.fileManifest().writeFile("options.go", GoWriter.HEADER + options);
        String title = service.getTrait(software.amazon.smithy.model.traits.TitleTrait.class).map(t -> t.getValue()).orElse("Caitlyn API");
        ctx.fileManifest().writeFile("doc.go", GoWriter.HEADER + Names.comment("Package " + s.packageName() + " is the Go SDK for the "
                + title + ", generated from its Smithy model by caitlyn-go-codegen. It depends only on the standard library and "
                + "the hand-written runtime " + s.coreModule() + " (which adds the OpenTelemetry API); it reads no AWS configuration outside AWSIAM sign-in.", "")
                + "package " + s.packageName() + "\n");
        // A runtime inside the SDK's own module (github.com/caitlyn-ai/caitlyn-go/core) needs no go.mod entry: the
        // module's go.mod is hand-written, beside the runtime. A separate runtime module gets one.
        if (!s.coreModule().startsWith(s.module() + "/")) {
            StringBuilder mod = new StringBuilder("module " + s.module() + "\n\ngo 1.23\n\nrequire " + s.coreModule() + " " + s.coreVersion() + "\n");
            if (!s.coreReplace().isEmpty()) {
                mod.append("\n// Development only: the runtime is not published yet.\nreplace ").append(s.coreModule()).append(" => ").append(s.coreReplace()).append("\n");
            }
            ctx.fileManifest().writeFile("go.mod", mod.toString());
        }
    }

    private static String resource(String name) {
        try (InputStream in = ServiceGenerator.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new CodegenException("missing resource " + name);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new CodegenException(e);
        }
    }

    /**
     * Every error shape in the service, by status. The class of an error response is the one for its HTTP status
     * whether or not the operation models it (PROTOCOL.md 6.2); the operation's own list is documentation.
     */
    private List<StructureShape> serviceErrors() {
        return new software.amazon.smithy.model.neighbor.Walker(model).walkShapes(service).stream()
                .filter(s -> s.isStructureShape() && s.hasTrait(software.amazon.smithy.model.traits.ErrorTrait.class)
                        && s.hasTrait(HttpErrorTrait.class))
                .map(s -> (StructureShape) s)
                .sorted(java.util.Comparator.comparingInt((StructureShape s) -> s.expectTrait(HttpErrorTrait.class).getCode()))
                .toList();
    }

}
