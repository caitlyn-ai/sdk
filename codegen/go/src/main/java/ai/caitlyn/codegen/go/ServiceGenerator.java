package ai.caitlyn.codegen.go;

import ai.caitlyn.codegen.model.CaitlynTraits;
import ai.caitlyn.codegen.model.ScopeTree;
import ai.caitlyn.codegen.model.ScopeTree.Fill;
import ai.caitlyn.codegen.model.ScopeTree.Kind;
import ai.caitlyn.codegen.model.ScopeTree.LongRunning;
import ai.caitlyn.codegen.model.ScopeTree.Method;
import ai.caitlyn.codegen.model.ScopeTree.Node;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.PaginationInfo;
import software.amazon.smithy.model.knowledge.TopDownIndex;
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
import software.amazon.smithy.model.traits.HttpResponseCodeTrait;
import software.amazon.smithy.model.traits.RetryableTrait;

/**
 * Writes everything that is not a shape, from the scope tree (PROTOCOL.md 10, spec 2.3): a Go type for each node of
 * the client (collections, scopes, named scopes, namespaces), their methods, each operation's request builder and
 * response reader, the results of calls that create a thing or start work, client.go, version.go, options.go (a fixed
 * file re-exporting the runtime's options), doc.go and go.mod.
 *
 * <p>Each operation's request is built from an unexported params struct holding every input member. The exported
 * {@code <Operation>Input} holds only what the caller gives: the identifiers a scope fills, the filters a scope's
 * watch fills, the file of an {@code @uploadTarget}, If-Match and the idempotency key are not in it.
 */
final class ServiceGenerator {

    private final GoContext ctx;
    private final Model model;
    private final ServiceShape service;
    private final ModelFacts facts;
    private final String core;
    private final GoScopes scopes;
    private final ScopeTree tree;
    private final Map<ShapeId, OperationInfo> ops = new LinkedHashMap<>();
    /** Input members that are not the caller's to give, per operation. */
    private final Map<ShapeId, Set<String>> excluded = new HashMap<>();
    /** The node each operation's own code (params, builder, reader) is written beside. */
    private final Map<ShapeId, Node> home = new LinkedHashMap<>();
    /** Each node's methods, with the estimate methods placed beside their jobs. */
    private final Map<Node, List<Method>> methodsOf = new IdentityHashMap<>();

    ServiceGenerator(GoContext ctx, ServiceShape service) {
        this.ctx = ctx;
        this.model = ctx.model();
        this.service = service;
        this.facts = ctx.facts();
        this.core = ctx.settings().coreModule();
        for (OperationShape op : new TreeSet<>(TopDownIndex.of(model).getContainedOperations(service))) {
            if (CaitlynTraits.omittedFromSdk(op)) {
                continue;
            }
            ops.put(op.getId(), new OperationInfo(model, service, op));
        }
        this.tree = ScopeTree.of(model, service);
        Set<String> shapeNames = new HashSet<>();
        model.shapes().filter(s -> s.isStructureShape() || s.isEnumShape() || s.isUnionShape())
                .forEach(s -> shapeNames.add(ctx.symbolProvider().toSymbol(s).getName()));
        this.scopes = new GoScopes(tree, shapeNames);
        for (Node n : scopes.nodes()) {
            methodsOf.put(n, new ArrayList<>(n.methods));
            for (Method m : n.methods) {
                place(n, m);
                m.estimate.ifPresent(e -> place(n, e));
            }
            n.watch.flatMap(LongRunning::filter).ifPresent(f -> excluded.computeIfAbsent(n.watch.get().watch(), k -> new HashSet<>()).add(f));
        }
        for (OperationInfo op : ops.values()) {
            if (!home.containsKey(op.op.getId())) {
                throw new CodegenException(op.op.getId() + " has no place in the scope tree");
            }
        }
    }

    private void place(Node n, Method m) {
        ShapeId id = m.operation.getId();
        home.putIfAbsent(id, n);
        Set<String> ex = excluded.computeIfAbsent(id, k -> new HashSet<>());
        for (Fill f : m.fills) {
            ex.add(f.member());
        }
        UploadTarget t = facts.uploadTargets.get(id);
        if (t != null && !t.nested()) {
            ex.add(t.member().getMemberName());
        }
    }

    void run() {
        Map<Node, List<OperationInfo>> opsAt = new IdentityHashMap<>();
        for (OperationInfo op : ops.values()) {
            opsAt.computeIfAbsent(home.get(op.op.getId()), k -> new ArrayList<>()).add(op);
        }
        for (Node n : scopes.nodes()) {
            if (n.kind == Kind.ROOT) {
                continue;
            }
            String file = "api_" + String.join("_", Names.words(scopes.type(n))) + ".go";
            ctx.writerDelegator().useFileWriter(file, "", w -> {
                nodeType(w, n);
                for (OperationInfo op : opsAt.getOrDefault(n, List.of())) {
                    operation(w, op);
                }
            });
        }
        client(opsAt.getOrDefault(tree.root, List.of()));
        version();
        staticFiles();
    }

    private Shape target(MemberShape m) {
        return model.expectShape(m.getTarget());
    }

    private static String doc(Shape s) {
        return s.getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
    }

    private OperationInfo info(Method m) {
        return ops.get(m.operation.getId());
    }

    // ------------------------------------------------------------------ one operation's own code

    private void operation(GoWriter w, OperationInfo op) {
        w.imp("context").imp(core);
        inputType(w, op);
        paramsType(w, op);
        descriptor(w, op);
        builder(w, op);
        switch (op.kind) {
            case UNARY -> {
                reader(w, op);
                call(w, op);
            }
            case PAGINATED -> {
                reader(w, op);
                pages(w, op);
            }
            case STREAM -> stream(w, op);
        }
    }

    private String resultType(OperationInfo op) {
        Optional<MemberShape> thing = payload(op);
        return ctx.symbolProvider().toSymbol(thing.isPresent() ? target(thing.get()) : op.output).getName();
    }

    /** The thing the call returns (its output's @httpPayload), or empty for an output that is a result of its own. */
    private Optional<MemberShape> payload(OperationInfo op) {
        return Optional.ofNullable(facts.thingPayloads.get(op.output.getId()));
    }

    /** The structure whose fields the call's return value has: the thing, or the output itself. */
    private StructureShape returned(OperationInfo op) {
        return payload(op).map(m -> model.expectShape(m.getTarget(), StructureShape.class)).orElse(op.output);
    }

    private boolean isEstimate(OperationInfo op) {
        return op.op.findTrait(ScopeTree.ESTIMATE).isPresent();
    }

    /** The members the caller gives, in model order: an estimate's file description is not one of them. */
    private List<OperationInfo.Param> inputFields(OperationInfo op) {
        Set<String> ex = excluded.getOrDefault(op.op.getId(), Set.of());
        return op.fields.stream().filter(p -> !ex.contains(p.member().getMemberName()) && !describesFile(p)).toList();
    }

    /** A member that is an UploadDescription, or a list of them: what an estimate sends in place of a file. */
    private boolean describesFile(OperationInfo.Param p) {
        Shape t = target(p.member());
        Shape item = t instanceof ListShape list ? model.expectShape(list.getMember().getTarget()) : t;
        return item.getId().getName().equals("UploadDescription");
    }

    /** The job an estimate is for. */
    private OperationInfo jobOf(OperationInfo est) {
        return ops.get(ShapeId.from(CaitlynTraits.stringMember(est.op, ScopeTree.ESTIMATE, "for").orElseThrow()));
    }

    /**
     * An estimate of a job that takes a file: it takes the file plus its own input members only (a file's description
     * stands for the job's file). Any other estimate takes its job's arguments.
     */
    private boolean fileEstimate(OperationInfo op) {
        if (!isEstimate(op)) {
            return false;
        }
        UploadTarget t = facts.uploadTargets.get(jobOf(op).op.getId());
        return t != null && !t.nested();
    }

    /** Whether the operation's methods take an Input (an estimate of a job without a file takes its job's). */
    private boolean hasInput(OperationInfo op) {
        return (!isEstimate(op) || fileEstimate(op)) && !inputFields(op).isEmpty();
    }

    private String paramsType(OperationInfo op) {
        return Names.lowerFirst(op.name) + "Params";
    }

    private void inputType(GoWriter w, OperationInfo op) {
        if (!hasInput(op)) {
            return;
        }
        String name = op.inputType();
        StringBuilder extra = new StringBuilder();
        op.ifMatch.ifPresent(p -> extra.append(" If-Match is the call option WithIfMatch").append(ifMatchRequired(op) ? " (required)." : " (optional)."));
        op.idempotency.ifPresent(p -> extra.append(" The idempotency key is generated, or set with WithIdempotencyKey."));
        w.l(Names.comment(name + " is what the caller gives " + op.name + "; the scope it is called on fills the identifiers." + extra, ""));
        w.l("type " + name + " struct {\n");
        for (OperationInfo.Param p : inputFields(op)) {
            field(w, op, p, true);
        }
        w.l("}\n\n");
    }

    private void paramsType(GoWriter w, OperationInfo op) {
        w.l("// " + paramsType(op) + " is every member of " + op.name + "'s input: the caller's, and those the scope fills.\n");
        w.l("type " + paramsType(op) + " struct {\n");
        for (OperationInfo.Param p : op.fields) {
            field(w, op, p, false);
        }
        w.l("}\n\n");
    }

    private void field(GoWriter w, OperationInfo op, OperationInfo.Param p, boolean documented) {
        MemberShape m = p.member();
        if (p.location() == HttpBinding.Location.PAYLOAD) {
            throw new CodegenException(m.getId() + ": @httpPayload inputs are not supported yet");
        }
        if (documented) {
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
        }
        String tag = p.location() == HttpBinding.Location.DOCUMENT ? p.wire() + (m.isRequired() ? "" : omit(target(m))) : "-";
        if (documented && attachmentsOf(op).filter(a -> a.equals(p)).isPresent()) {
            // Attachments (PROTOCOL.md 16): files (a Path, an *UploadFile) uploaded first, or an UploadID used as it is.
            w.l("\t//\n\t// Each is a file (a Path, an *UploadFile), uploaded for this call before it is made, or an UploadID already\n"
                    + "\t// reserved for it and sent, used as it is; they are named in this order.\n");
            w.l("\t" + p.field() + " []File `json:\"-\"`\n");
            return;
        }
        w.l("\t" + p.field() + " " + ctx.types().member(m, w) + " `json:\"" + tag + "\"`\n");
    }

    /**
     * The attachments member of a generated call ({uploadId} references) whose upload purpose its labels make: the
     * caller's input takes files there (CreateUnattendedRun's, purpose {unattendedRun: {agentId, version}}). A
     * hand-written call (a conversation's Send) handles its own.
     */
    private Optional<OperationInfo.Param> attachmentsOf(OperationInfo op) {
        if (ctx.settings().handWritten().contains(op.op.getId().getName()) || attachmentPurpose(op, "p").isEmpty()) {
            return Optional.empty();
        }
        return op.fields.stream().filter(p -> p.location() == HttpBinding.Location.DOCUMENT && target(p.member()) instanceof ListShape l
                && model.expectShape(l.getMember().getTarget()) instanceof StructureShape item && item.getAllMembers().size() == 1
                && item.getMember("uploadId").isPresent()).findFirst();
    }

    /**
     * The UploadPurpose an attachment of this call is reserved with, as Go over the params `v`: a member named as a label
     * ({ConversationID: …}), or a member made of the labels ({UnattendedRun: &UnattendedRunUploadPurpose{AgentID: …}}).
     */
    private Optional<String> attachmentPurpose(OperationInfo op, String v) {
        Optional<StructureShape> purpose = model.getShape(ShapeId.fromParts(service.getId().getNamespace(), "UploadPurpose")).flatMap(Shape::asStructureShape);
        if (purpose.isEmpty()) {
            return Optional.empty();
        }
        List<OperationInfo.Param> labels = op.fields.stream().filter(p -> p.location() == HttpBinding.Location.LABEL).toList();
        for (OperationInfo.Param l : labels) {
            if (purpose.get().getMember(l.member().getMemberName()).isPresent()) {
                return Optional.of("&UploadPurpose{" + Names.exported(l.member().getMemberName()) + ": Ptr(" + v + "." + l.field() + ")}");
            }
        }
        Set<String> names = new java.util.HashSet<>(labels.stream().map(p -> p.member().getMemberName()).toList());
        for (MemberShape pm : purpose.get().getAllMembers().values()) {
            if (!(model.expectShape(pm.getTarget()) instanceof StructureShape st) || st.getAllMembers().isEmpty() || !names.containsAll(st.getAllMembers().keySet())) {
                continue;
            }
            String inner = st.getAllMembers().keySet().stream()
                    .map(k -> Names.exported(k) + ": " + v + "." + labels.stream().filter(p -> p.member().getMemberName().equals(k)).findFirst().orElseThrow().field())
                    .collect(java.util.stream.Collectors.joining(", "));
            return Optional.of("&UploadPurpose{" + Names.exported(pm.getMemberName()) + ": &" + Names.exported(st.getId().getName()) + "{" + inner + "}}");
        }
        return Optional.empty();
    }

    /**
     * The tag that leaves an unset optional member out: omitzero for a list or map, so an empty one set on purpose is
     * sent (`roles: []` clears every grant) while nil is left out; omitempty for the rest.
     */
    static String omit(Shape target) {
        return target.isListShape() || target.isMapShape() ? ",omitzero" : ",omitempty";
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
        if (op.http.getCode() >= 300 && op.http.getCode() < 400) {
            d.append("\tRedirect: ").append(op.http.getCode()).append(",\n");
        }
        op.idempotency.ifPresent(p -> d.append("\tIdempotencyHeader: ").append(Names.str(p.wire())).append(",\n"));
        op.ifMatch.filter(p -> ifMatchRequired(op)).ifPresent(p -> d.append("\tIfMatchRequired: true,\n"));
        if (!retryable.isEmpty()) {
            d.append("\tRetryable: []int{").append(String.join(", ", retryable)).append("},\n");
        }
        // The @range rules the request carries, checked before sending (PROTOCOL.md 3)
        List<ai.caitlyn.codegen.model.Ranges.Rule> rules = ai.caitlyn.codegen.model.Ranges.of(model, service.getId()).getOrDefault(op.name, List.of());
        if (!rules.isEmpty()) {
            d.append("\tRanges: []core.Range{\n");
            for (ai.caitlyn.codegen.model.Ranges.Rule r : rules) {
                d.append("\t\t{Where: ").append(Names.str(r.where())).append(", Path: ").append(Names.str(r.path()))
                    .append(r.min().map(v -> ", Min: core.Bound(" + ai.caitlyn.codegen.model.Ranges.number(v) + ")").orElse(""))
                    .append(r.max().map(v -> ", Max: core.Bound(" + ai.caitlyn.codegen.model.Ranges.number(v) + ")").orElse(""))
                    .append("},\n");
            }
            d.append("\t},\n");
        }
        d.append("\tErrors: errorForStatus,\n}\n\n");
        w.l(d.toString());
    }

    // ------------------------------------------------------------------ requests

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

    private String isSet(OperationInfo.Param p) {
        if (p.member().isRequired()) {
            return "true";
        }
        return GoTypes.pointable(target(p.member())) ? "in." + p.field() + " != nil" : "len(in." + p.field() + ") > 0";
    }

    private void builder(GoWriter w, OperationInfo op) {
        w.l("func build" + op.name + "(in *" + paramsType(op) + ") (*core.Request, error) {\n");
        for (OperationInfo.Param p : op.all) {
            if (p.location() == HttpBinding.Location.LABEL && target(p.member()).isStringShape()) {
                w.l("\tif in." + p.field() + " == \"\" {\n\t\treturn nil, core.MissingInput(" + Names.str(op.name) + ", "
                        + Names.str(p.member().getMemberName()) + ")\n\t}\n");
            }
        }
        StringBuilder path = new StringBuilder();
        StringBuilder literal = new StringBuilder();
        for (SmithyPattern.Segment seg : op.http.getUri().getSegments()) {
            literal.append('/');
            if (seg.isLabel()) {
                OperationInfo.Param p = op.param(seg.getContent()).orElseThrow();
                // A greedy label ({folderPath+}) keeps its slashes: each segment is escaped on its own.
                path.append(path.length() > 0 ? " + " : "").append(Names.str(literal.toString()))
                        .append(seg.isGreedyLabel() ? " + core.GreedyPathLabel(" : " + core.PathLabel(")
                        .append(format(target(p.member()), "in." + p.field(), w, p.member())).append(")");
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
                w.l("\tfor _, v := range in." + p.field() + " {\n\t\t" + set + Names.str(p.wire()) + ", "
                        + format(item, "v", w, p.member()) + ")\n\t}\n");
            } else if (isPointer(p)) {
                w.l("\tif in." + p.field() + " != nil {\n\t\t" + set + Names.str(p.wire()) + ", "
                        + format(t, "*in." + p.field(), w, p.member()) + ")\n\t}\n");
            } else {
                w.l("\t" + set + Names.str(p.wire()) + ", " + format(t, "in." + p.field(), w, p.member()) + ")\n");
            }
        }
        for (OperationInfo.Param p : op.all) {
            Optional<String> since = CaitlynTraits.since(p.member());
            if (since.isPresent() && op.fields.contains(p) && op.since.map(s -> ModelFacts.compareVersions(since.get(), s) > 0).orElse(true)) {
                w.l("\tif " + isSet(p) + " {\n\t\treq.Set = append(req.Set, core.Since{Member: " + Names.str(p.member().getMemberName())
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
        if (payload(op).isPresent()) {
            thingReader(w, op, bindings);
            return;
        }
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

    /**
     * A call that returns a thing (PROTOCOL.md 4): the body is the thing. Its etag is filled from the ETag header when the
     * body has none; the other headers (Location) are not kept, and the response metadata goes on the thing.
     */
    private void thingReader(GoWriter w, OperationInfo op, Map<String, HttpBinding> bindings) {
        StructureShape thing = returned(op);
        w.l("\tif err := resp.DecodeJSON(out); err != nil {\n\t\treturn nil, err\n\t}\n");
        for (HttpBinding b : bindings.values()) {
            if (b.getLocation() != HttpBinding.Location.HEADER || !b.getLocationName().equalsIgnoreCase("ETag")) {
                continue;
            }
            MemberShape etag = thing.getMember("etag").orElse(null);
            if (etag == null) {
                throw new CodegenException(op.op.getId() + ": the call returns " + thing.getId().getName() + " with an ETag header, and it has no etag member");
            }
            if (etag.isRequired()) {
                w.l("\tif out.ETag == \"\" {\n\t\tout.ETag = resp.HeaderValue(" + Names.str(b.getLocationName()) + ")\n\t}\n");
            } else {
                w.l("\tif out.ETag == nil {\n\t\tout.ETag = resp.HeaderPtr(" + Names.str(b.getLocationName()) + ")\n\t}\n");
            }
        }
        w.l("\tout.metadata = resp.Metadata()\n");
        w.l("\treturn out, nil\n}\n\n");
    }

    private void call(GoWriter w, OperationInfo op) {
        String result = resultType(op);
        w.l("func (c *Client) call" + op.name + "(ctx context.Context, p *" + paramsType(op) + ", opts []CallOption) (*" + result + ", error) {\n");
        w.l("\treq, err := build" + op.name + "(p)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tresp, err := c.core.Do(ctx, op" + op.name + ", req, opts)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\treturn read" + op.name + "(resp)\n}\n\n");
    }

    private record PageInfo(String itemType, String page, String cursorField, String items, String next) {}

    private PageInfo pageInfo(OperationInfo op, GoWriter w) {
        PaginationInfo pi = op.pagination.orElseThrow();
        if (pi.getOutputTokenMemberPath().size() != 1 || pi.getItemsMemberPath().size() != 1) {
            throw new CodegenException(op.op.getId() + ": nested pagination paths are not supported yet");
        }
        MemberShape items = pi.getItemsMemberPath().get(0);
        MemberShape next = pi.getOutputTokenMemberPath().get(0);
        if (pi.getInputTokenMember().isRequired() || next.isRequired()) {
            throw new CodegenException(op.op.getId() + ": required pagination tokens are not supported yet");
        }
        String itemType = ctx.types().base(model.expectShape(((ListShape) target(items)).getMember().getTarget()), w);
        return new PageInfo(itemType, resultType(op), Names.exported(pi.getInputTokenMember().getMemberName()),
                Names.exported(items.getMemberName()), Names.exported(next.getMemberName()));
    }

    private void pages(GoWriter w, OperationInfo op) {
        w.imp("iter");
        PageInfo pi = pageInfo(op, w);
        // One page, which knows how to read the page after it (NextPage, PROTOCOL.md 10), and the pages from a cursor
        w.l("func (c *Client) page" + op.name + "(ctx context.Context, p *" + paramsType(op) + ", opts []CallOption) (*" + pi.page() + ", error) {\n");
        w.l("\treq, err := build" + op.name + "(p)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tresp, err := c.core.Do(ctx, op" + op.name + ", req, opts)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tout, err := read" + op.name + "(resp)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tif out.HasNextPage() {\n\t\tnext := *p\n\t\tnext." + pi.cursorField() + " = out." + pi.next() + "\n"
                + "\t\tout.nextPage = func(ctx context.Context) (*" + pi.page() + ", error) { return c.page" + op.name + "(ctx, &next, opts) }\n\t}\n");
        w.l("\treturn out, nil\n}\n\n");
        w.l("func (c *Client) pages" + op.name + "(ctx context.Context, p *" + paramsType(op) + ", opts []CallOption) iter.Seq2[*" + pi.page() + ", error] {\n");
        w.l("\treturn core.Pages(ctx, p." + pi.cursorField() + ", func(ctx context.Context, cursor *string) (*" + pi.page() + ", *string, error) {\n");
        w.l("\t\tpage := *p\n\t\tpage." + pi.cursorField() + " = cursor\n");
        w.l("\t\tout, err := c.page" + op.name + "(ctx, &page, opts)\n\t\tif err != nil {\n\t\t\treturn nil, nil, err\n\t\t}\n");
        w.l("\t\treturn out, out." + pi.next() + ", nil\n\t})\n}\n\n");
    }

    // ------------------------------------------------------------------ streams

    private final Set<String> emittedFinals = new HashSet<>();

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

    /**
     * A stream's type alias. It is named after its event union, as `SendMessage`'s ConversationEventStream is.
     * When operations stream the same union and only some of them end with a final event, the ones without
     * (WatchConversation, which carries on until it is closed) are named after the operation instead.
     */
    private String streamAlias(OperationInfo op) {
        ObjectNode sse = op.sse.orElseThrow();
        String events = sse.expectStringMember("events").getValue();
        String union = Names.exported(ShapeId.from(events).getName());
        boolean siblingHasFinal = ops.values().stream()
                .filter(o -> o.sse.isPresent() && o.sse.get().expectStringMember("events").getValue().equals(events))
                .anyMatch(o -> o.sse.get().getStringMember("final").isPresent());
        boolean ownFinal = sse.getStringMember("final").isPresent();
        return !ownFinal && siblingHasFinal ? Names.exported(op.name) + "Stream" : union + "Stream";
    }

    private Optional<OperationInfo.Param> lastEventID(OperationInfo op) {
        return op.all.stream().filter(p -> p.location() == HttpBinding.Location.HEADER && p.wire().equalsIgnoreCase("Last-Event-ID")).findFirst();
    }

    private void stream(GoWriter w, OperationInfo op) {
        StreamTypes st = streamTypes(w, op);
        String alias = streamAlias(op);
        String target = "core.Stream[" + st.union() + ", " + st.finalType() + "]";
        String prev = streamAliases.putIfAbsent(alias, target);
        if (prev == null) {
            boolean hasFinal = !st.finalType().equals("struct{}");
            w.l(Names.comment(alias + " is a stream of " + st.union() + " events. "
                    + (hasFinal ? "Range over Events, then call FinalMessage for the *" + st.finalType() + "; always Close it."
                            : "Range over Events until you have what you need, then Close it: the stream has no final event.")
                    + " A dropped connection is resumed where the model allows.", ""));
            w.l("type " + alias + " = " + target + "\n\n");
        } else if (!prev.equals(target)) {
            throw new CodegenException(op.op.getId() + ": two streams of " + st.union() + " with different final events");
        }
        ObjectNode sse = op.sse.orElseThrow();
        String resume = "nil";
        boolean fresh = false;
        Optional<String> resumeWith = sse.getStringMember("resumeWith").map(s -> s.getValue());
        if (resumeWith.isPresent()) {
            OperationInfo r = ops.get(ShapeId.from(resumeWith.get()));
            if (r == null) {
                throw new CodegenException(op.op.getId() + ": resumeWith " + resumeWith.get() + " is not a generated operation");
            }
            StringBuilder b = new StringBuilder("func(ctx context.Context, lastEventID string) (*core.Response, error) {\n");
            Optional<OperationInfo.Param> last = lastEventID(r);
            if (r.op.getId().equals(op.op.getId())) {
                // A watch resumes itself: the same request again (what it listens to included). With a Last-Event-ID
                // member it carries on from the last event, in place of an `after` cursor (PROTOCOL.md 5.6); without
                // one, every connection starts afresh with a snapshot (PROTOCOL.md 16).
                b.append("\t\t\trin := *p\n");
                if (last.isPresent()) {
                    b.append("\t\t\tif lastEventID != \"\" {\n");
                    b.append("\t\t\t\trin.").append(last.get().field()).append(" = ").append(isPointer(last.get()) ? "&lastEventID" : "lastEventID").append("\n");
                    r.all.stream().filter(rp -> rp.member().getMemberName().equals("after")).findFirst()
                            .ifPresent(after -> b.append("\t\t\t\trin.").append(after.field()).append(" = nil\n"));
                    b.append("\t\t\t}\n");
                } else {
                    fresh = true;
                }
                b.append("\t\t\trreq, err := build").append(r.name).append("(&rin)\n");
            } else {
                if (last.isEmpty()) {
                    throw new CodegenException(r.op.getId() + ": resuming another operation's stream needs a Last-Event-ID header member");
                }
                b.append("\t\t\trin := &").append(paramsType(r)).append("{}\n");
                for (OperationInfo.Param rp : r.all) {
                    if (rp == last.get()) {
                        b.append("\t\t\tif lastEventID != \"\" {\n\t\t\t\trin.").append(rp.field()).append(" = ")
                                .append(isPointer(rp) ? "&lastEventID" : "lastEventID").append("\n\t\t\t}\n");
                        continue;
                    }
                    if (rp.location() != HttpBinding.Location.LABEL) {
                        continue;
                    }
                    String member = rp.member().getMemberName();
                    OperationInfo.Param src = op.param(member).orElseThrow(() ->
                            new CodegenException(r.op.getId() + ": label " + member + " has no member of the same name in " + op.op.getId()));
                    b.append("\t\t\trin.").append(rp.field()).append(" = p.").append(src.field()).append("\n");
                }
                b.append("\t\t\trreq, err := build").append(r.name).append("(rin)\n");
            }
            b.append("\t\t\tif err != nil {\n\t\t\t\treturn nil, err\n\t\t\t}\n");
            b.append("\t\t\treturn c.core.Do(ctx, op").append(r.name).append(", rreq, nil)\n\t\t}");
            resume = b.toString();
        }
        w.l("func (c *Client) stream" + op.name + "(ctx context.Context, p *" + paramsType(op) + ", opts []CallOption) (*" + alias + ", error) {\n");
        w.l("\treq, err := build" + op.name + "(p)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tresp, err := c.core.Do(ctx, op" + op.name + ", req, opts)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\treturn core.OpenStream(ctx, resp, core.StreamSpec[" + st.union() + ", " + st.finalType() + "]{\n");
        w.l("\t\tDecode: decode" + st.union() + "(errorForStatus, " + !st.finalType().equals("struct{}") + "),\n\t\tFinal: " + st.finalFn()
                + ",\n\t\tResume: " + resume + ",\n" + (fresh ? "\t\tFresh: true,\n" : "") + "\t}), nil\n}\n\n");
    }

    // ------------------------------------------------------------------ the client's types (PROTOCOL.md 10)

    /** How a node's code refers to the client: the root is the client itself. */
    private static String client(Node n) {
        return n.kind == Kind.ROOT ? "c" : "s.c";
    }

    private static String recv(Node n) {
        return n.kind == Kind.ROOT ? "c" : "s";
    }

    /** Whether values of the node's type need the client and identifiers: they have calls of their own. */
    private boolean callsOwn(Node n) {
        if (!methodsOf.get(n).isEmpty() || n.watch.isPresent()) {
            return true;
        }
        for (Node c : n.children.values()) {
            if (GoScopes.empty(c)) {
                continue;
            }
            if (c.kind == Kind.SCOPE && c.alias.isPresent()) {
                return true;
            }
            if (c.kind == Kind.COLLECTION && c.scope != null && !GoScopes.empty(c.scope)) {
                return true;
            }
        }
        return false;
    }

    /** The node's identifiers the caller sets (a named scope's fixed one is not a parameter). */
    private static List<String> givenIDs(Node n) {
        return GoScopes.held(n).stream().filter(i -> i.fixed().isEmpty()).map(i -> GoScopes.idVar(i.name())).toList();
    }

    /** The field children of a node: namespaces, collections with calls, and singletons. */
    private List<Node> fieldChildren(Node n) {
        List<Node> out = new ArrayList<>();
        for (Node c : n.children.values()) {
            if (GoScopes.empty(c)) {
                continue;
            }
            if (c.kind == Kind.NAMESPACE || GoScopes.singleton(c) || GoScopes.collectionField(c)) {
                out.add(c);
            }
        }
        return out;
    }

    private String typeDoc(Node n) {
        String type = scopes.type(n);
        String what = n.resource.map(ServiceGenerator::doc).map(String::strip).orElse("");
        return switch (n.kind) {
            case COLLECTION -> type + " holds the calls on " + n.path() + " as a whole (" + String.join(", ", methodNames(n)) + ")."
                    + (n.scope != null && !GoScopes.empty(n.scope) ? " One of them is " + scopes.type(n.scope) + ", made by its parent's "
                    + Names.exported(n.singular) + " method." : "");
            case SCOPE -> GoScopes.made(n)
                    ? type + " is one " + Names.words(n.alias.isPresent() ? n.alias.get() : n.parent.singular).stream().reduce((a, b) -> a + " " + b).orElse("")
                    + " (" + n.path() + "): a reference made without sending anything; every call on it fills its identifiers."
                    + (what.isEmpty() ? "" : "\n\n" + what)
                    : type + " holds the calls on " + n.path() + "." + (what.isEmpty() ? "" : "\n\n" + what);
            default -> type + " groups the calls under " + n.path() + ".";
        };
    }

    private List<String> methodNames(Node n) {
        List<String> out = new ArrayList<>();
        for (Method m : methodsOf.get(n)) {
            out.add(Names.exported(m.name));
            m.estimate.ifPresent(e -> out.add("Estimate" + Names.exported(m.name)));
        }
        return out;
    }

    private void nodeType(GoWriter w, Node n) {
        String type = scopes.type(n);
        boolean own = callsOwn(n);
        List<Node> fields = fieldChildren(n);
        Set<String> members = new HashSet<>();
        w.l(Names.comment(typeDoc(n), ""));
        w.l("type " + type + " struct {\n");
        for (Node c : fields) {
            claim(members, n, Names.exported(c.name));
            w.l("\t" + Names.exported(c.name) + " *" + scopes.type(c) + "\n");
        }
        if (own) {
            w.l("\n\tc *Client\n");
            for (ScopeTree.Identifier i : GoScopes.held(n)) {
                w.l("\t" + GoScopes.idVar(i.name()) + " string\n");
            }
        }
        w.l("}\n\n");
        constructor(w, n, fields, own);
        identifier(w, n, members);
        children(w, n, members);
        for (Method m : methodsOf.get(n)) {
            method(w, n, m, members);
        }
        watchAndWait(w, n, members);
    }

    /**
     * The scope's own identifier, as a method: ID() for an …Id (knowledgeBaseId, documentId), else the identifier's last
     * word (folderPath gives Path(), fieldKey Key()). A Created… handle has it through its embedded scope, so
     * created.ID() is the new thing's identifier. A named scope's fixed identifier (draft, live) has none.
     */
    private void identifier(GoWriter w, Node n, Set<String> members) {
        if (n.kind != Kind.SCOPE || n.identifiers.isEmpty() || !callsOwn(n)) {
            return;
        }
        ScopeTree.Identifier own = n.identifiers.get(n.identifiers.size() - 1);
        // A singleton (a knowledge base's access) holds its parent's identifiers, none of its own
        if (own.fixed().isPresent() || (n.parent != null && GoScopes.held(n.parent).stream().anyMatch(i -> i.name().equals(own.name())))) {
            return;
        }
        List<String> words = Names.words(own.name());
        String last = words.get(words.size() - 1);
        String name = last.equalsIgnoreCase("id") ? "ID" : Names.exported(last);
        claim(members, n, name);
        String type = scopes.type(n);
        String what = name.equals("ID") ? String.join(" ", words.subList(0, words.size() - 1)).toLowerCase() + "'s identifier"
                : String.join(" ", words).toLowerCase();
        w.l("// " + name + " is the " + what + " this scope was made with.\n");
        w.l("func (s *" + type + ") " + name + "() string { return s." + GoScopes.idVar(own.name()) + " }\n\n");
    }

    private void constructor(GoWriter w, Node n, List<Node> fields, boolean own) {
        String type = scopes.type(n);
        List<String> ids = givenIDs(n);
        String params = ids.isEmpty() ? "" : ", " + String.join(", ", ids) + " string";
        w.l("func new" + type + "(c *Client" + params + ") *" + type + " {\n\treturn &" + type + "{\n");
        for (Node c : fields) {
            List<String> cids = givenIDs(c);
            w.l("\t\t" + Names.exported(c.name) + ": new" + scopes.type(c) + "(c" + (cids.isEmpty() ? "" : ", " + String.join(", ", cids)) + "),\n");
        }
        if (own) {
            w.l("\t\tc: c,\n");
            for (ScopeTree.Identifier i : GoScopes.held(n)) {
                w.l("\t\t" + GoScopes.idVar(i.name()) + ": " + i.fixed().map(Names::str).orElse(GoScopes.idVar(i.name())) + ",\n");
            }
        }
        w.l("\t}\n}\n\n");
    }

    private void claim(Set<String> members, Node n, String name) {
        if (!members.add(name)) {
            throw new CodegenException(scopes.type(n) + "." + name + " would be given to two members");
        }
    }

    /** The methods that make a child's value: a collection's scope by its singular, a named scope by its name. */
    private void children(GoWriter w, Node n, Set<String> members) {
        String r = recv(n);
        String type = n.kind == Kind.ROOT ? "Client" : scopes.type(n);
        for (Node c : n.children.values()) {
            if (GoScopes.empty(c)) {
                continue;
            }
            if (c.kind == Kind.SCOPE && c.alias.isPresent()) {
                String name = Names.exported(c.alias.get());
                claim(members, n, name);
                String fixed = c.identifiers.get(c.identifiers.size() - 1).fixed().orElseThrow();
                w.l(Names.comment(name + " is the " + Names.str(fixed) + " " + Names.words(c.resource.get().getId().getName()).get(0)
                        + " (" + c.path() + "), a named scope: it sends nothing until a call is made on it.", ""));
                w.l("func (" + r + " *" + type + ") " + name + "() *" + scopes.type(c) + " {\n");
                w.l("\treturn new" + scopes.type(c) + "(" + client(n) + idArgs(n, givenIDs(c)) + ")\n}\n\n");
            } else if (c.kind == Kind.COLLECTION && c.scope != null && !GoScopes.empty(c.scope)) {
                String name = Names.exported(c.singular);
                claim(members, n, name);
                List<String> own = c.identifiers.stream().map(i -> GoScopes.idVar(i.name())).toList();
                w.l(Names.comment(name + " is one of " + c.path() + " by its " + String.join(" and ", c.identifiers.stream()
                        .map(i -> Names.words(i.name()).stream().reduce((a, b) -> a + " " + b).orElse("")).toList())
                        + ": a reference made without sending anything, whose calls fill " + (own.size() > 1 ? "them" : "it") + " in.", ""));
                w.l("func (" + r + " *" + type + ") " + name + "(" + String.join(", ", own) + " string) *" + scopes.type(c.scope) + " {\n");
                w.l("\treturn new" + scopes.type(c.scope) + "(" + client(n) + idArgs(n, givenIDs(c.scope)) + ")\n}\n\n");
            }
        }
    }

    /** ", s.knowledgeBaseID, documentID": each identifier from the receiver when it holds it, else the parameter. */
    private String idArgs(Node n, List<String> ids) {
        Set<String> heldHere = new HashSet<>();
        if (callsOwn(n)) {
            GoScopes.held(n).forEach(i -> heldHere.add(GoScopes.idVar(i.name())));
        }
        StringBuilder b = new StringBuilder();
        for (String id : ids) {
            b.append(", ").append(heldHere.contains(id) ? recv(n) + "." + id : id);
        }
        return b.toString();
    }

    // ------------------------------------------------------------------ methods

    private static final java.util.function.UnaryOperator<String> NIL = e -> "nil, " + e;

    private record Sig(String params, String args) {}

    /** A method's parameters after ctx and before opts: leading identifiers, the file, the input. */
    private Sig signature(Node n, Method m, OperationInfo op, OperationInfo inputOf) {
        List<String> params = new ArrayList<>();
        for (String l : m.leading) {
            params.add(GoScopes.idVar(l) + " string");
        }
        UploadTarget t = facts.uploadTargets.get(inputOf.op.getId());
        if (t != null && !t.nested() || fileEstimate(inputOf)) {
            params.add("file File");
        }
        if (hasInput(inputOf)) {
            params.add("in *" + inputOf.inputType());
        }
        String p = "ctx context.Context" + (params.isEmpty() ? "" : ", " + String.join(", ", params)) + ", opts ...CallOption";
        return new Sig(p, "");
    }

    /** Builds p, the params, from the input and the scope: the body every method starts with. */
    private void fillParams(GoWriter w, Node n, Method m, OperationInfo op, OperationInfo inputOf, java.util.function.UnaryOperator<String> fail) {
        w.l("\tp := &" + paramsType(op) + "{}\n");
        if (hasInput(inputOf)) {
            w.l("\tif in != nil {\n");
            for (OperationInfo.Param ip : inputFields(inputOf)) {
                Optional<OperationInfo.Param> pp = op.param(ip.member().getMemberName());
                if (pp.isEmpty() || !op.fields.contains(pp.get())) {
                    continue; // an estimate takes its job's input, and sends only what it shares with the job
                }
                if (attachmentsOf(op).filter(a -> a.equals(pp.get())).isPresent()) {
                    continue; // uploaded once the scope has filled the labels its purpose names, below
                }
                String from = ctx.types().member(ip.member(), w);
                String to = ctx.types().member(pp.get().member(), w);
                if (!from.equals(to)) {
                    throw new CodegenException(op.op.getId() + "." + ip.member().getMemberName() + " is " + to + ", but " + inputOf.op.getId()
                            + "'s is " + from + ": an estimate's members must match its job's");
                }
                w.l("\t\tp." + pp.get().field() + " = in." + ip.field() + "\n");
            }
            w.l("\t}\n");
        }
        for (Fill f : m.fills) {
            OperationInfo.Param pp = op.param(f.member()).orElseThrow();
            String v = m.leading.contains(f.identifier()) ? GoScopes.idVar(f.identifier()) : recv(n) + "." + GoScopes.idVar(f.identifier());
            if (f.trimSlashes()) {
                w.imp(core);
                v = "core.TrimFolder(" + v + ")";
            }
            Shape t = target(pp.member());
            if (t.isEnumShape()) {
                v = ctx.types().base(t, w) + "(" + v + ")";
            } else if (!t.isStringShape()) {
                throw new CodegenException(op.op.getId() + "." + f.member() + ": a scope fills only string members");
            }
            w.l("\tp." + pp.field() + " = " + (isPointer(pp) ? "Ptr(" + v + ")" : v) + "\n");
        }
        // Attachments (PROTOCOL.md 16): each file uploaded first, reserved for what the call is on, in order; an UploadID is
        // used as it is. The first that fails ends the call, and nothing is sent.
        Optional<OperationInfo.Param> attach = attachmentsOf(op);
        if (attach.isPresent() && op == inputOf && hasInput(inputOf)) {
            OperationInfo.Param a = attach.get();
            String item = ctx.types().base(model.expectShape(((ListShape) target(a.member())).getMember().getTarget()), w);
            w.l("\tif in != nil {\n\t\tfor _, f := range in." + a.field() + " {\n"
                    + "\t\t\tid, err := " + client(n) + ".uploadID(ctx, f, " + attachmentPurpose(op, "p").orElseThrow() + ")\n"
                    + "\t\t\tif err != nil {\n\t\t\t\treturn " + fail.apply("err") + "\n\t\t\t}\n"
                    + "\t\t\tp." + a.field() + " = append(p." + a.field() + ", " + item + "{UploadID: id})\n\t\t}\n\t}\n");
        }
        // Each member the estimate shares with nothing else is a description of the job's file.
        if (isEstimate(op)) {
            OperationInfo job = jobOf(op);
            UploadTarget t = facts.uploadTargets.get(job.op.getId());
            for (OperationInfo.Param pp : op.fields) {
                Shape tt = target(pp.member());
                boolean list = tt instanceof ListShape;
                Shape item = list ? model.expectShape(((ListShape) tt).getMember().getTarget()) : tt;
                if (!item.getId().getName().equals("UploadDescription")) {
                    continue;
                }
                if (t == null || t.nested()) {
                    throw new CodegenException(op.op.getId() + "." + pp.member().getMemberName() + " describes a file, but "
                            + job.op.getId() + " takes none");
                }
                w.l("\td, err := " + client(n) + ".describeFile(ctx, file)\n\tif err != nil {\n\t\treturn " + fail.apply("err") + "\n\t}\n");
                w.l("\tp." + pp.field() + " = " + (list ? "[]UploadDescription{*d}" : pp.member().isRequired() ? "*d" : "d") + "\n");
            }
        } else {
            UploadTarget t = facts.uploadTargets.get(op.op.getId());
            if (t != null) {
                upload(w, n, op, t, fail);
            }
        }
    }

    /**
     * An @uploadTarget: at the top level the method takes the file in place of the member; nested, the structure that
     * holds the identifier has a file field beside it. Either way the file is sent as Core.Uploads.Send does, and its
     * upload's id goes where the identifier goes.
     */
    private void upload(GoWriter w, Node n, OperationInfo op, UploadTarget target, java.util.function.UnaryOperator<String> fail) {
        String purpose = "nil";
        if (target.purpose().isPresent()) {
            OperationInfo presigned = presigned();
            MemberShape pm = presigned.input.getMember("purpose").orElseThrow();
            purpose = "&" + ctx.symbolProvider().toSymbol(model.expectShape(pm.getTarget())).getName() + "{"
                    + Names.exported(target.purpose().get()) + ": Ptr(true)}";
        }
        String cl = client(n);
        if (op.ifMatch.isPresent() && ifMatchRequired(op)) {
            // If-Match is required: refused before the file is uploaded, so nothing is sent
            w.l("\tif err := core.RequireIfMatch(op" + op.name + ", opts); err != nil {\n\t\treturn " + fail.apply("err") + "\n\t}\n");
        }
        if (!target.nested()) {
            OperationInfo.Param pp = op.param(target.member().getMemberName()).orElseThrow();
            w.l("\tid, err := " + cl + ".uploadID(ctx, file, " + purpose + ")\n\tif err != nil {\n\t\treturn " + fail.apply("err") + "\n\t}\n");
            w.l("\tp." + pp.field() + " = " + (isPointer(pp) ? "&id" : "id") + "\n");
            return;
        }
        // The Go expression of each structure on the path: p.Avatar, p.Avatar.Mark.
        List<String> exprs = new ArrayList<>(List.of("p"));
        for (int i = 0; i < target.path().size() - 1; i++) {
            exprs.add(exprs.get(i) + "." + Names.exported(target.path().get(i).getMemberName()));
        }
        String holder = exprs.get(exprs.size() - 1);
        StringBuilder cond = new StringBuilder();
        for (int i = 1; i < exprs.size(); i++) {
            cond.append(exprs.get(i)).append(" != nil && ");
        }
        cond.append(holder).append(".").append(target.fileField()).append(" != nil");
        String id = Names.exported(target.member().getMemberName());
        w.l("\tif " + cond + " {\n");
        w.l("\t\tid, err := " + cl + ".uploadID(ctx, " + holder + "." + target.fileField() + ", " + purpose + ")\n");
        w.l("\t\tif err != nil {\n\t\t\treturn " + fail.apply("err") + "\n\t\t}\n");
        // Copy each structure on the path, so the caller's input is never changed.
        String parent = "p";
        for (int i = 1; i < exprs.size(); i++) {
            String field = Names.exported(target.path().get(i - 1).getMemberName());
            String var = "s" + i;
            w.l("\t\t" + var + " := *" + parent + "." + field + "\n\t\t" + parent + "." + field + " = &" + var + "\n");
            parent = var;
        }
        w.l("\t\t" + parent + "." + id + " = " + (target.member().isRequired() ? "id" : "&id") + "\n");
        w.l("\t\t" + parent + "." + target.fileField() + " = nil\n\t}\n");
    }

    private OperationInfo presigned() {
        return ops.values().stream().filter(o -> o.op.hasTrait(CaitlynTraits.PRESIGNED_UPLOAD)).findFirst()
                .orElseThrow(() -> new CodegenException("@uploadTarget needs a @presignedUpload operation"));
    }

    /**
     * Whether a call must send If-Match (PROTOCOL.md 4, conformance case if-match.optional-set): on every operation with
     * an If-Match header except those the model marks @ifMatchOptional, whatever the member's own @required says.
     */
    private static boolean ifMatchRequired(OperationInfo op) {
        return op.ifMatch.isPresent() && !op.op.hasTrait(ShapeId.from("ai.caitlyn.traits#ifMatchOptional"));
    }

    private String methodDoc(OperationInfo op, String methodName, String extra) {
        StringBuilder text = new StringBuilder(doc(op.op).strip());
        if (!extra.isEmpty()) {
            text.append("\n\n").append(extra);
        }
        op.ifMatch.ifPresent(p -> text.append("\n\n").append(ifMatchRequired(op)
                ? "Pass caitlyn.WithIfMatch(etag), the ETag you last read: it is required, and a call without it fails with an input error before anything is sent."
                : "caitlyn.WithIfMatch(etag) is optional: without it the change applies to the thing as it stands; with it, a stale ETag is refused with 412.")
                .append(" WithIfMatch(\"*\") (any version) is sent only when you pass it yourself: no helper fills it in."));
        op.since.ifPresent(s -> text.append("\n\nSince Caitlyn ").append(s).append(op.stability.equals("ga") ? "." : "; " + op.stability + "."));
        return Names.doc(methodName, text.toString(), true, "");
    }

    private void method(GoWriter w, Node n, Method m, Set<String> members) {
        w.imp("context");
        OperationInfo op = info(m);
        // An operation whose exported method is hand-written (GoSettings.handWritten) keeps the generated one unexported.
        String name = ctx.settings().handWritten().contains(m.operation.getId().getName()) ? m.name : Names.exported(m.name);
        String type = n.kind == Kind.ROOT ? "Client" : scopes.type(n);
        String r = recv(n);
        Sig sig = signature(n, m, op, op);
        switch (op.kind) {
            case STREAM -> {
                claim(members, n, name);
                String alias = streamAlias(op);
                w.l(methodDoc(op, name, "The request is sent before " + name + " returns, whether or not the stream is read. "
                        + "The error for a failed request is returned at once; errors during the stream (an error event, a connection "
                        + "that could not be resumed, cancellation) end Events with that error."));
                w.l("func (" + r + " *" + type + ") " + name + "(" + sig.params() + ") (*" + alias + ", error) {\n");
                fillParams(w, n, m, op, op, NIL);
                w.l("\treturn " + client(n) + ".stream" + op.name + "(ctx, p, opts)\n}\n\n");
            }
            case PAGINATED -> {
                claim(members, n, name);
                claim(members, n, name + "Pages");
                claim(members, n, name + "Page");
                w.imp("iter").imp(core);
                PageInfo pi = pageInfo(op, w);
                String args = String.join("", m.leading.stream().map(l -> GoScopes.idVar(l) + ", ").toList()) + (hasInput(op) ? "in, " : "");
                w.l(methodDoc(op, name, "It yields every item, fetching pages as needed; " + name + "Pages yields whole pages, and " + name + "Page reads one."));
                w.l("func (" + r + " *" + type + ") " + name + "(" + sig.params() + ") iter.Seq2[" + pi.itemType() + ", error] {\n");
                w.l("\treturn core.Items(" + r + "." + name + "Pages(ctx, " + args + "opts...), func(p *" + pi.page() + ") []" + pi.itemType()
                        + " { return p." + pi.items() + " })\n}\n\n");
                w.l(Names.comment(name + "Pages yields the pages of " + name + ", from the input's " + pi.cursorField() + " (normally unset) to the last page.", ""));
                w.l("func (" + r + " *" + type + ") " + name + "Pages(" + sig.params() + ") iter.Seq2[*" + pi.page() + ", error] {\n");
                fillParams(w, n, m, op, op, e -> "core.Fail[*" + pi.page() + "](" + e + ")");
                w.l("\treturn " + client(n) + ".pages" + op.name + "(ctx, p, opts)\n}\n\n");
                // PROTOCOL.md 10: one page, for a caller that shows a page at a time and keeps the next cursor itself.
                w.l(Names.comment(name + "Page reads one page of " + name + ", from the input's " + pi.cursorField() + " (the first page when it is unset): exactly one request. "
                        + "The page's " + pi.next() + ", given as " + pi.cursorField() + ", reads the page after it.", ""));
                w.l("func (" + r + " *" + type + ") " + name + "Page(" + sig.params() + ") (*" + pi.page() + ", error) {\n");
                w.l("\treturn core.First(" + r + "." + name + "Pages(ctx, " + args + "opts...))\n}\n\n");
            }
            case UNARY -> {
                claim(members, n, name);
                unaryMethod(w, n, m, op, name, type, sig);
            }
        }
        m.estimate.ifPresent(e -> {
            claim(members, n, "Estimate" + name);
            estimate(w, n, m, e, name, type);
        });
    }

    private void unaryMethod(GoWriter w, Node n, Method m, OperationInfo op, String name, String type, Sig sig) {
        String r = recv(n);
        String result = resultType(op);
        if (m.creates.isPresent()) {
            Node scope = m.creates.get().collection().scope;
            String created = createdType(scope);
            w.l(methodDoc(op, name, "It returns the new " + Names.words(m.creates.get().collection().singular).stream().reduce((a, b) -> a + " " + b).orElse("")
                    + "'s scope, with the response as Result." + (m.longRunning.isPresent() ? " Wait follows the work the call started." : "")));
            w.l("func (" + r + " *" + type + ") " + name + "(" + sig.params() + ") (*" + created + ", error) {\n");
            fillParams(w, n, m, op, op, NIL);
            w.l("\tout, err := " + client(n) + ".call" + op.name + "(ctx, p, opts)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
            String source = m.creates.get().source();
            String newID = source.startsWith("input:") ? "p." + goPath(op.input, source.substring("input:".length()), false)
                    : "out." + outputPath(op, source.substring("output:".length()));
            List<String> ids = givenIDs(scope);
            StringBuilder args = new StringBuilder();
            for (int i = 0; i < ids.size(); i++) {
                args.append(", ").append(i == ids.size() - 1 ? newID : r + "." + ids.get(i));
            }
            w.l("\treturn &" + created + "{" + scopes.type(scope) + ": new" + scopes.type(scope) + "(" + client(n) + args + "), "
                    + "Result: out" + (scope.watch.isPresent() ? jobField(op, "out") : "") + "}, nil\n}\n\n");
            createdTypes.computeIfAbsent(created, k -> new ArrayList<>()).add(new Created(scope, op, m));
            return;
        }
        if (m.longRunning.isPresent()) {
            Started st = started(n, m, op);
            w.l(methodDoc(op, name, "It returns the response, as Result, with Wait, which follows the work the call started"
                    + (st.delete() ? " until the thing is gone." : ".")));
            w.l("func (" + r + " *" + type + ") " + name + "(" + sig.params() + ") (*" + st.type() + ", error) {\n");
            fillParams(w, n, m, op, op, NIL);
            w.l("\tout, err := " + client(n) + ".call" + op.name + "(ctx, p, opts)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
            w.l("\treturn &" + st.type() + "{Result: out, scope: " + st.scopeExpr() + jobField(op, "out") + "}, nil\n}\n\n");
            startedType(w, st, op);
            return;
        }
        w.l(methodDoc(op, name, ""));
        w.l("func (" + r + " *" + type + ") " + name + "(" + sig.params() + ") (*" + result + ", error) {\n");
        fillParams(w, n, m, op, op, NIL);
        w.l("\treturn " + client(n) + ".call" + op.name + "(ctx, p, opts)\n}\n\n");
    }

    /** A path into the output as a selector on what the call returns: the thing itself when the path starts at its payload. */
    private String outputPath(OperationInfo op, String path) {
        Optional<MemberShape> thing = payload(op);
        if (thing.isPresent() && path.startsWith(thing.get().getMemberName() + ".")) {
            return goPath(returned(op), path.substring(thing.get().getMemberName().length() + 1), false);
        }
        return goPath(op.output, path, false);
    }

    /** A dotted member path as a Go selector, through required members only. */
    private String goPath(StructureShape root, String path, boolean allowOptionalLeaf) {
        StringBuilder out = new StringBuilder();
        Shape cur = root;
        String[] segs = path.split("\\.");
        for (int i = 0; i < segs.length; i++) {
            if (!(cur instanceof StructureShape s)) {
                throw new CodegenException(root.getId() + ": " + path + " walks into a non-structure");
            }
            String seg = segs[i];
            MemberShape m = s.getMember(seg).orElseThrow(() -> new CodegenException(root.getId() + ": no member " + seg + " on the path " + path));
            if (!m.isRequired() && !(allowOptionalLeaf && i == segs.length - 1)) {
                throw new CodegenException(m.getId() + ": a new scope's identifier must come through required members");
            }
            out.append(i == 0 ? "" : ".").append(Names.exported(seg));
            cur = target(m);
        }
        return out.toString();
    }

    /** ", job: <the job's id>" when the response names the work it started (an Operation, or a Job). */
    private String jobField(OperationInfo op, String out) {
        if (payload(op).isPresent()) {
            return "";
        }
        for (String member : List.of("operation", "job")) {
            Optional<MemberShape> m = op.output.getMember(member);
            if (m.isPresent() && target(m.get()) instanceof StructureShape s && s.getMember("id").isPresent()) {
                String f = out + "." + Names.exported(member);
                return m.get().isRequired() ? ", job: " + f + ".ID" : ", job: func() string {\n\t\tif " + f + " != nil {\n\t\t\treturn " + f + ".ID\n\t\t}\n\t\treturn \"\"\n\t}()";
            }
        }
        return "";
    }

    // ------------------------------------------------------------------ calls that create a thing or start work

    private record Created(Node scope, OperationInfo op, Method m) {}

    private final Map<String, List<Created>> createdTypes = new LinkedHashMap<>();

    private String createdType(Node scope) {
        String t = scopes.type(scope).replaceFirst("(Scope|Ref)$", "");
        return "Created" + t;
    }

    /**
     * Created…: the new thing's scope, embedded, and the create's response as Result (PROTOCOL.md 16): the thing itself
     * when the call returns one (KnowledgeBase), else its named result (CreateDocumentResult).
     */
    private void createdType(GoWriter w, Created c) {
        String type = createdType(c.scope());
        String scopeType = scopes.type(c.scope());
        String result = resultType(c.op());
        boolean thing = payload(c.op()).isPresent();
        w.l(Names.comment(type + " is what " + c.op().name + " returns: the new thing's scope (" + scopeType + "), embedded, and "
                + (thing ? "the new " + result + ", with the response's metadata," : "the response (" + result + ")") + " as Result.", ""));
        if (c.scope().children.containsKey("result") || methodsOf.get(c.scope()).stream().anyMatch(m -> Names.exported(m.name).equals("Result"))) {
            throw new CodegenException(type + ": the scope has a member named Result");
        }
        w.l("type " + type + " struct {\n\t*" + scopeType + "\n\t// Result is " + (thing ? "the new " + result + ", as the call returned it." : "the call's response.")
                + "\n\tResult *" + result + "\n" + (c.scope().watch.isPresent() ? "\n\tjob string\n" : "") + "}\n\n");
        w.imp("encoding/json");
        w.l(thing ? "// MarshalJSON writes the new " + result + ".\n" : "// MarshalJSON writes the response, as " + c.op().name + " answered it.\n");
        w.l("func (s *" + type + ") MarshalJSON() ([]byte, error) { return json.Marshal(s.Result) }\n\n");
        if (c.scope().watch.isPresent()) {
            String waitType = waitType(c.scope());
            w.l("// Wait waits until the work " + c.op().name + " started is done, then returns the " + waitWhat(c.scope())
                    + ", as " + scopeType + ".Wait does.\n");
            w.l("func (s *" + type + ") Wait(ctx context.Context, opts ...WaitOption) (" + waitType + ", error) {\n\treturn s." + scopeType
                    + ".wait(ctx, s.job, false, opts)\n}\n\n");
        }
    }

    private record Started(String type, Node scope, String scopeExpr, boolean delete, boolean job, boolean cancels) {}

    /**
     * What a call that starts work on an existing thing returns: its response with Wait. Wait follows the work through
     * the scope that watches it (the one whose watch is the call's @longRunning): until the thing is done, until it is
     * gone after a delete, or, for work with no thing of its own (a fill-in, a reprocess), until the job ends.
     */
    private Started started(Node n, Method m, OperationInfo op) {
        LongRunning lr = m.longRunning.get();
        Node scope = null;
        for (Node p = n; p != null; p = p.parent) {
            if (p.kind == Kind.SCOPE && p.watch.isPresent() && p.watch.get().watch().equals(lr.watch()) && p.watch.get().filter().equals(lr.filter())) {
                scope = p;
                break;
            }
        }
        if (scope == null) {
            throw new CodegenException(op.op.getId() + ": no scope above " + n.path() + " watches " + lr.watch().getName() + lr.filter().map(f -> " with " + f).orElse(""));
        }
        boolean delete = m.name.equals("delete");
        boolean job = !delete && scope != n && lr.filter().isEmpty();
        String expr = scope == n ? "s" : "new" + scopes.type(scope) + "(" + client(n) + idArgs(n, givenIDs(scope)) + ")";
        return new Started(op.name + "Started", scope, expr, delete, job, lr.cancels());
    }

    private void startedType(GoWriter w, Started st, OperationInfo op) {
        String result = resultType(op);
        String scopeType = scopes.type(st.scope());
        w.l(Names.comment(st.type() + " is what " + op.name + " returns: the call's response as Result, and Wait, which follows the work it started.", ""));
        w.l("type " + st.type() + " struct {\n\t// Result is the call's response.\n\tResult *" + result + "\n\n\tscope *" + scopeType + "\n\tjob    string\n}\n\n");
        w.imp("encoding/json");
        w.l("// MarshalJSON writes the response, as " + op.name + " answered it.\n");
        w.l("func (r *" + st.type() + ") MarshalJSON() ([]byte, error) { return json.Marshal(r.Result) }\n\n");
        String alias = streamAlias(ops.get(st.scope().watch.get().watch()));
        w.l("// Watch opens the watch that follows the work the call started, as " + scopeType + ".Watch does: a snapshot first, then each change.\n");
        // A watch that takes the caller's input (an unattended run's, with its Last-Event-ID) is opened with none.
        ShapeId watchId = st.scope().watch.get().watch();
        boolean ownWatch = methodsOf.get(st.scope()).stream().anyMatch(m -> m.operation.getId().equals(watchId));
        String in = ownWatch && hasInput(ops.get(watchId)) ? "nil, " : "";
        w.l("func (r *" + st.type() + ") Watch(ctx context.Context, opts ...CallOption) (*" + alias + ", error) {\n\treturn r.scope.Watch(ctx, " + in + "opts...)\n}\n\n");
        if (st.delete()) {
            w.l("// Wait waits until the thing is gone, and returns nil then; a job that failed or was cancelled ends it with its error.\n");
            w.l("func (r *" + st.type() + ") Wait(ctx context.Context, opts ...WaitOption) error {\n\t_, err := r.scope.wait(ctx, r.job, true, opts)\n\treturn err\n}\n\n");
        } else if (st.job()) {
            w.l("// Wait waits until the job the call started ends, and returns it. One that ended completed_with_failures returns\n"
                    + "// with its partial failures; one that failed returns its error as the typed error for its code, and one that was\n"
                    + "// cancelled an *Error with the code CANCELLED.\n");
            w.l("func (r *" + st.type() + ") Wait(ctx context.Context, opts ...WaitOption) (*Job, error) {\n\treturn r.scope.waitJob(ctx, r.job, opts)\n}\n\n");
        } else {
            String waitType = waitType(st.scope());
            if (st.cancels()) {
                // A cancel's own wait (@longRunning(cancels: true); PROTOCOL.md 16, wait.cancel-returns): the work
                // ending cancelled is what the call asked for, so the thing is returned, not CANCELLED
                w.l("// Wait waits until the work has stopped, then returns the " + waitWhat(st.scope()) + ". The work ending cancelled is what\n"
                        + "// the call asked for: it returns the thing, not CANCELLED. Another failure is still its error.\n");
                w.l("func (r *" + st.type() + ") Wait(ctx context.Context, opts ...WaitOption) (" + waitType + ", error) {\n\treturn r.scope.wait(cancelling(ctx), r.job, false, opts)\n}\n\n");
            } else {
                w.l("// Wait waits until the work the call started is done, then returns the " + waitWhat(st.scope()) + ", as " + scopeType + ".Wait does.\n");
                w.l("func (r *" + st.type() + ") Wait(ctx context.Context, opts ...WaitOption) (" + waitType + ", error) {\n\treturn r.scope.wait(ctx, r.job, false, opts)\n}\n\n");
            }
        }
    }

    // ------------------------------------------------------------------ estimates

    private void estimate(GoWriter w, Node n, Method job, Method est, String jobName, String type) {
        OperationInfo eop = info(est);
        OperationInfo jop = info(job);
        String name = "Estimate" + jobName;
        OperationInfo inputOf = fileEstimate(eop) ? eop : jop;
        Sig sig = signature(n, job, eop, inputOf);
        String result = resultType(eop);
        w.l(methodDoc(eop, name, fileEstimate(eop)
                ? "It takes " + jobName + "'s file and its own input, and starts nothing: of the file it sends only a description "
                        + "(name, content type, size and the hints WithHints gave), uploading nothing."
                : "It takes " + jobName + "'s arguments and starts nothing."));
        w.l("func (" + recv(n) + " *" + type + ") " + name + "(" + sig.params() + ") (*" + result + ", error) {\n");
        fillParams(w, n, est, eop, inputOf, NIL);
        w.l("\treturn " + client(n) + ".call" + eop.name + "(ctx, p, opts)\n}\n\n");
    }

    // ------------------------------------------------------------------ watch and wait (PROTOCOL.md 16)

    /** The snapshot member that holds the watched thing: the filter's name, or knowledgeBase for the whole watch. */
    private String snapshotMember(Node scope) {
        return scope.watch.get().filter().orElse("knowledgeBase");
    }

    private Optional<Method> get(Node scope) {
        return methodsOf.get(scope).stream().filter(m -> m.name.equals("get") && !hasInput(info(m)) && m.leading.isEmpty()).findFirst();
    }

    private String waitType(Node scope) {
        Optional<Method> get = get(scope);
        if (get.isPresent()) {
            return "*" + resultType(info(get.get()));
        }
        StructureShape snapshot = snapshotShape(scope);
        MemberShape m = snapshot.getMember(snapshotMember(scope)).orElseThrow(() -> new CodegenException(
                snapshot.getId() + " has no member " + snapshotMember(scope) + " for " + scope.path() + "'s wait"));
        return "*" + ctx.symbolProvider().toSymbol(target(m)).getName();
    }

    private String waitWhat(Node scope) {
        return get(scope).isPresent() ? "thing as Get returns it" : "thing as the watch's snapshot shows it";
    }

    private StructureShape snapshotShape(Node scope) {
        OperationInfo watch = ops.get(scope.watch.get().watch());
        UnionShape union = model.expectShape(ShapeId.from(watch.sse.orElseThrow().expectStringMember("events").getValue()), UnionShape.class);
        MemberShape first = union.getAllMembers().values().iterator().next();
        return model.expectShape(first.getTarget(), StructureShape.class);
    }

    private void watchAndWait(GoWriter w, Node n, Set<String> members) {
        if (n.watch.isEmpty()) {
            return;
        }
        w.imp("context");
        LongRunning lr = n.watch.get();
        OperationInfo watch = ops.get(lr.watch());
        String type = scopes.type(n);
        String alias = streamAlias(watch);
        boolean placed = methodsOf.get(n).stream().anyMatch(m -> m.operation.getId().equals(lr.watch()));
        if (!placed) {
            claim(members, n, "Watch");
            w.l(Names.comment("Watch opens " + lr.watch().getName() + " for this " + Names.words(n.parent.kind == Kind.COLLECTION ? n.parent.singular : n.name)
                    .stream().reduce((a, b) -> a + " " + b).orElse("") + " (" + lr.filter().map(f -> "its identifier as " + f).orElse("") + "). Its "
                    + "first event is a snapshot of how the thing stands, its jobs included, and every reconnect (after a dropped "
                    + "connection, or the server's clean end) starts again with a new snapshot, with no cursor.", ""));
            w.l("func (s *" + type + ") Watch(ctx context.Context, opts ...CallOption) (*" + alias + ", error) {\n");
            w.l("\tp := &" + paramsType(watch) + "{}\n");
            for (ScopeTree.Identifier i : GoScopes.held(n)) {
                watch.param(i.name()).ifPresent(pp -> w.l("\tp." + pp.field() + " = " + (isPointer(pp) ? "Ptr(s." + GoScopes.idVar(i.name()) + ")" : "s." + GoScopes.idVar(i.name())) + "\n"));
            }
            String filter = lr.filter().orElseThrow(() -> new CodegenException(n.path() + ": a scope's watch without a filter must be its own watch method"));
            OperationInfo.Param fp = watch.param(filter).orElseThrow();
            String last = GoScopes.idVar(n.identifiers.get(n.identifiers.size() - 1).name());
            w.l("\tp." + fp.field() + " = " + (isPointer(fp) ? "Ptr(s." + last + ")" : "s." + last) + "\n");
            Optional<Method> batchGet = filter.equals("batch") ? get(n) : Optional.empty();
            if (batchGet.isPresent()) {
                // A batch's watch reads the batch again once its deadline has passed (PROTOCOL.md 16, go/deadline.go).
                w.l("\tctx, cancel := context.WithCancel(ctx)\n");
                w.l("\tst, err := s.c.stream" + watch.name + "(ctx, p, opts)\n");
                w.l("\tif err != nil {\n\t\tcancel()\n\t\treturn nil, err\n\t}\n");
                w.l("\treturn rereadAtDeadline(st, cancel, s." + Names.exported(batchGet.get().name) + "), nil\n}\n\n");
            } else {
                w.l("\treturn s.c.stream" + watch.name + "(ctx, p, opts)\n}\n\n");
            }
        }
        claim(members, n, "Wait");
        String waitType = waitType(n);
        String helper = "wait" + watch.name;
        if (ai.caitlyn.codegen.model.ProcessingWatch.endsOnStatus(model, n)) {
            statusWait(watch.name);
            w.l(Names.comment("Wait waits until the run has ended, through Watch, then returns it as Get returns it, whatever its status: succeeded, failed, cancelled, interrupted or untracked. A run's failure is data on the run (Failure), never an error. A run that is gone ends the wait with its *NotFoundError. WithTimeLimit bounds the wait (there is no default); cancelling ctx ends it with ctx's error.", ""));
        } else
        w.l(Names.comment("Wait waits until no job is running on the " + Names.words(n.parent.kind == Kind.COLLECTION ? n.parent.singular : n.name)
                .stream().reduce((a, b) -> a + " " + b).orElse("") + ", through Watch, then returns the " + waitWhat(n) + ". A job that "
                + "ended completed_with_failures returns, with the partial failures on the thing; one that failed returns its error as "
                + "the typed error for its code, and one that was cancelled an *Error with the code CANCELLED. A thing that is gone ends "
                + "the wait with its *NotFoundError. WithTimeLimit bounds the wait (there is no default); cancelling ctx ends it with "
                + "ctx's error.", ""));
        w.l("func (s *" + type + ") Wait(ctx context.Context, opts ...WaitOption) (" + waitType + ", error) {\n\treturn s.wait(ctx, \"\", false, opts)\n}\n\n");
        w.l("func (s *" + type + ") wait(ctx context.Context, job string, gone bool, opts []WaitOption) (" + waitType + ", error) {\n");
        String subject = lr.filter().map(f -> "s." + GoScopes.idVar(n.identifiers.get(n.identifiers.size() - 1).name())).orElse("s." + GoScopes.idVar(n.identifiers.get(0).name()));
        w.l("\tseen, err := " + helper + "(ctx, s.Watch, " + Names.str(lr.filter().orElse("")) + ", " + subject + ", job, gone, opts)\n");
        w.l("\tif err != nil || seen == nil {\n\t\treturn nil, err\n\t}\n");
        Optional<Method> get = get(n);
        if (get.isPresent()) {
            w.l("\tv, err := s." + Names.exported(get.get().name) + "(ctx)\n\treturn waited(ctx, v, err)\n}\n\n");
        } else {
            w.l("\treturn seen." + Names.exported(snapshotMember(n)) + ", nil\n}\n\n");
        }
    }

    // ------------------------------------------------------------------ client, version, fixed files

    private void client(List<OperationInfo> rootOps) {
        ctx.writerDelegator().useFileWriter("client.go", "", w -> {
            w.imp(core).imp("context");
            Node root = tree.root;
            String title = service.getTrait(software.amazon.smithy.model.traits.TitleTrait.class).map(t -> t.getValue()).orElse("Caitlyn API");
            List<Node> fields = fieldChildren(root);
            w.l(Names.comment("Client is the " + title + " client. Create one with NewClient and share it: it is safe for concurrent use. "
                    + "Its calls are scopes (PROTOCOL.md 10): c.KnowledgeBases.List(ctx) for the collection, c.KnowledgeBase(id) for one "
                    + "knowledge base, whose calls fill its identifier in, such as c.KnowledgeBase(id).Document(docID).Get(ctx). Making a "
                    + "scope sends nothing.", ""));
            w.l("type Client struct {\n");
            Set<String> members = new HashSet<>(List.of("ServerVersion", "Endpoint", "Auth"));
            for (Node c : fields) {
                claim(members, root, Names.exported(c.name));
                w.l("\t" + Names.exported(c.name) + " *" + scopes.type(c) + "\n");
            }
            w.l("\n\tcore *core.Client\n}\n\n");
            w.l(Names.comment("NewClient returns a client for workspace (for example \"your-company.getcaitlyn.ai\"), authenticated by auth "
                    + "(for example caitlyn.Token(\"cait-pat-…\") or caitlyn.ClientCredentials{…}). The workspace sets the endpoint and the token audience, "
                    + "https://<workspace>/api. Options set the endpoint, the HTTP client, retries and telemetry; "
                    + "nothing is read from the environment, except by caitlyn.AWSIAM sign-in.", ""));
            w.l("func NewClient(workspace string, auth Auth, opts ...Option) (*Client, error) {\n");
            w.l("\tcc, err := core.NewClient(core.SDKInfo{Version: core.ModuleVersion(ModulePath, SDKVersion), ModelVersion: ModelVersion}, workspace, auth, opts...)\n");
            w.l("\tif err != nil {\n\t\treturn nil, err\n\t}\n\tc := &Client{core: cc}\n");
            for (Node c : fields) {
                w.l("\tc." + Names.exported(c.name) + " = new" + scopes.type(c) + "(c)\n");
            }
            w.l("\treturn c, nil\n}\n\n");
            w.l("// ServerVersion is the latest Caitlyn-Api-Version the client has seen, or \"\" before any response.\n");
            w.l("func (c *Client) ServerVersion() string { return c.core.ServerVersion() }\n\n");
            w.l("// Endpoint is the base URL requests are sent to: https://<workspace>/api, or the WithEndpoint value.\n");
            w.l("func (c *Client) Endpoint() string { return c.core.Endpoint() }\n\n");
            w.l("// Auth is the client's sign-in: its mode and token, and the OAuth mode's steps (AuthorizationURL,\n");
            w.l("// HandleCallback, SignOut).\n");
            w.l("func (c *Client) Auth() *AuthSession { return c.core.Auth() }\n\n");
            children(w, root, members);
            for (Method m : methodsOf.get(root)) {
                method(w, root, m, members);
            }
            for (OperationInfo op : rootOps) {
                operation(w, op);
            }
            errorTables(w);
            uploadHelpers(w);
            for (List<Created> cs : createdTypes.values()) {
                createdType(w, cs.get(0));
            }
        });
    }

    /** errorForStatus (by HTTP status, PROTOCOL.md 6.2) and statusForCode (by problem code, the model's @errorCodes). */
    private void errorTables(GoWriter w) {
        w.l("// errorForStatus is the typed error for an HTTP status (PROTOCOL.md 6.2): every operation's, whether or not it lists it.\n");
        w.l("func errorForStatus(status int, e *core.APIError) error {\n\tswitch status {\n");
        for (StructureShape e : serviceErrors()) {
            w.l("\tcase " + e.expectTrait(HttpErrorTrait.class).getCode() + ":\n\t\treturn &" + ctx.symbolProvider().toSymbol(e).getName() + "{e}\n");
        }
        w.l("\t}\n\treturn e\n}\n\n");
        w.l("// statusForCode is the HTTP status of the error class a problem code belongs to (the model's @errorCodes), or 0 for a\n"
                + "// code no class lists: a failed job's error is raised as that class (PROTOCOL.md 16).\n");
        w.l("func statusForCode(code string) int {\n\tswitch code {\n");
        for (StructureShape e : serviceErrors()) {
            Optional<software.amazon.smithy.model.node.Node> codes = CaitlynTraits.node(e, CaitlynTraits.ERROR_CODES);
            if (codes.isEmpty()) {
                continue;
            }
            List<String> quoted = codes.get().expectArrayNode().getElements().stream().map(x -> Names.str(x.expectStringNode().getValue())).toList();
            w.l("\tcase " + String.join(", ", quoted) + ":\n\t\treturn " + e.expectTrait(HttpErrorTrait.class).getCode() + "\n");
        }
        w.l("\t}\n\treturn 0\n}\n\n");
        // ErrorCode and a constant for every code: an alias of string, so err.Code (a string) compares with a constant
        // or a literal alike, and a code this SDK does not know yet is still a string.
        java.util.TreeMap<String, StructureShape> byCode = new java.util.TreeMap<>();
        for (StructureShape e : serviceErrors()) {
            CaitlynTraits.node(e, CaitlynTraits.ERROR_CODES).ifPresent(n -> n.expectArrayNode().getElements()
                    .forEach(x -> byCode.putIfAbsent(x.expectStringNode().getValue(), e)));
        }
        if (byCode.isEmpty()) {
            return;
        }
        w.l("// ErrorCode is a stable error code the API documents, as an error's Code holds it. It is a string, so\n"
                + "// err.Code == caitlyn.ErrorCodeNotFound and err.Code == \"NOT_FOUND\" are the same check, and a code this SDK\n"
                + "// does not know yet is still a string. Each code's page is https://build.caitlyn.ai/errors/{code}.\n");
        w.l("type ErrorCode = string\n\n");
        w.l("// The stable error codes the API documents, each with the error type it is raised as.\nconst (\n");
        byCode.forEach((code, e) -> w.l("\t// ErrorCode" + Names.exported(code) + " is " + code + ", raised as *" + ctx.symbolProvider().toSymbol(e).getName()
                + " (" + e.expectTrait(HttpErrorTrait.class).getCode() + ").\n\tErrorCode" + Names.exported(code) + " ErrorCode = " + Names.str(code) + "\n"));
        ai.caitlyn.codegen.model.SdkErrorCodes.CODES.forEach((code, what) -> {
            if (!byCode.containsKey(code)) {
                w.l("\t// ErrorCode" + Names.exported(code) + " is " + code + ", raised by the SDK itself with Status 0. " + what + "\n\tErrorCode"
                        + Names.exported(code) + " ErrorCode = " + Names.str(code) + "\n");
            }
        });
        w.l(")\n\n");
    }

    /**
     * Core.Uploads.Send for @presignedUpload, and the client's uploadID and describeFile, which every @uploadTarget
     * method and every estimate of one uses.
     */
    private void uploadHelpers(GoWriter w) {
        Optional<OperationInfo> found = ops.values().stream().filter(o -> o.op.hasTrait(CaitlynTraits.PRESIGNED_UPLOAD)).findFirst();
        if (found.isEmpty()) {
            return;
        }
        OperationInfo op = found.get();
        for (String m : List.of("fileName", "contentType", "byteSize", "sha256")) {
            op.param(m).orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs input member " + m));
        }
        for (String m : List.of("id", "uploadUrl", "uploadMethod", "requiredHeaders")) {
            op.output.getMember(m).orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs output member " + m));
        }
        Node at = home.get(op.op.getId());
        String type = scopes.type(at);
        String result = resultType(op);
        Optional<OperationInfo.Param> purpose = op.param("purpose");
        String purposeType = purpose.map(p -> ctx.types().member(p.member(), w)).orElse("");
        String purposeParam = purpose.map(p -> ", purpose " + purposeType).orElse("");
        Method reserve = methodsOf.get(at).stream().filter(m -> m.operation.getId().equals(op.op.getId())).findFirst().orElseThrow();
        if (methodsOf.get(at).stream().anyMatch(m -> m.name.equals("send"))) {
            throw new CodegenException(op.op.getId() + ": " + at.path() + " already has send; the upload helper needs the name");
        }
        w.l(Names.comment("Send uploads a file (PROTOCOL.md 10, 14): it reads the file once to compute its size and SHA-256 (a stream is "
                + "copied aside while it is read, to memory up to 8 MiB and past that to a temporary file removed when the call ends), "
                + "reserves the upload with " + Names.exported(reserve.name) + (purposeParam.isEmpty() ? "" : " (purpose is nil for a document)")
                + ", then sends the bytes to the upload URL with exactly the required headers, and no Caitlyn credentials. "
                + "The send is retried like any retry-safe call. A file over 2 GB is an *Error with the code FILE_TOO_LARGE, "
                + "a file changed on disk since it was read FILE_CHANGED, both before anything is sent; bytes the upload URL "
                + "would not take after retries UPLOAD_PUT_FAILED.", ""));
        w.l("func (s *" + type + ") Send(ctx context.Context, file File" + purposeParam + ", opts ...CallOption) (*" + result + ", error) {\n");
        w.l("\tf, err := core.FileOf(file)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tif f == nil {\n\t\treturn nil, core.NewError(\"VALIDATION_FAILED\", \"Send needs a file, not an upload that was already sent\", nil)\n\t}\n");
        w.l("\tvar up *" + result + "\n");
        w.l("\terr = s.c.core.SendFile(ctx, f, func(ctx context.Context, fi core.FileInfo) (core.PresignedPut, error) {\n");
        w.l("\t\tvar err error\n");
        w.l("\t\tup, err = s.c.call" + op.name + "(ctx, &" + paramsType(op) + "{" + Names.exported("fileName") + ": fi.Name, "
                + Names.exported("contentType") + ": fi.ContentType, " + Names.exported("byteSize") + ": fi.Size, "
                + Names.exported("sha256") + ": fi.SHA256" + purpose.map(p -> ", " + p.field() + ": purpose").orElse("") + "}, opts)\n");
        w.l("\t\tif err != nil {\n\t\t\treturn core.PresignedPut{}, err\n\t\t}\n");
        w.l("\t\treturn core.PresignedPut{Method: up." + Names.exported("uploadMethod") + ", URL: up." + Names.exported("uploadUrl")
                + ", Headers: up." + Names.exported("requiredHeaders") + "}, nil\n\t})\n");
        w.l("\tif err != nil {\n\t\treturn nil, err\n\t}\n\treturn up, nil\n}\n\n");
        // The file a method takes in place of an upload's id: sent first, unless it is an upload's id already.
        w.l("// uploadID sends file as " + type + ".Send does and returns its upload's id; an UploadID is returned as it is.\n");
        w.l("func (c *Client) uploadID(ctx context.Context, file File" + purposeParam + ") (string, error) {\n");
        w.l("\tf, err := core.FileOf(file)\n\tif err != nil {\n\t\treturn \"\", err\n\t}\n");
        w.l("\tif f == nil {\n\t\treturn string(file.(UploadID)), nil\n\t}\n");
        w.l("\tup, err := c.Core.Uploads.Send(ctx, f" + (purpose.isPresent() ? ", purpose" : "") + ")\n\tif err != nil {\n\t\treturn \"\", err\n\t}\n");
        w.l("\treturn up." + Names.exported("id") + ", nil\n}\n\n");
        w.l("// describeFile is the description of a file an estimate sends in place of its bytes: its name, content type and size.\n");
        w.l("func (c *Client) describeFile(ctx context.Context, file File) (*UploadDescription, error) {\n");
        w.l("\tf, err := core.FileOf(file)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\tif f == nil {\n\t\treturn nil, core.NewError(\"VALIDATION_FAILED\", \"An estimate needs the file, not an upload's id\", nil)\n\t}\n");
        w.l("\tfi, err := f.Describe(ctx)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n");
        w.l("\td := &UploadDescription{Name: fi.Name, ContentType: fi.ContentType, ByteSize: fi.Size}\n");
        String[] hintsType = {null};
        StructureShape desc = model.getStructureShapes().stream().filter(x -> x.getId().getName().equals("UploadDescription")
                && x.getId().getNamespace().equals(service.getId().getNamespace())).findFirst().orElseThrow();
        desc.getMember("hints").ifPresent(h -> {
            String ht = ctx.symbolProvider().toSymbol(target(h)).getName();
            w.l("\t// The hints the caller gave the file (WithHints): the SDK reads none from the bytes itself.\n");
            w.l("\tif h, ok := f.Hints().(*" + ht + "); ok {\n\t\td.Hints = h\n\t}\n");
            hintsType[0] = ht;
        });
        w.l("\treturn d, nil\n}\n\n");
        if (hintsType[0] != null) {
            w.l(Names.comment("WithHints gives what an estimate sends about a file's contents besides its size, such as its page count: "
                    + "caitlyn.WithHints(&caitlyn." + hintsType[0] + "{Pages: caitlyn.Ptr[int64](14)}). The SDK reads none from the bytes "
                    + "itself, so without hints the server prices a typical file of that size, and says so.", ""));
            w.l("func WithHints(h *" + hintsType[0] + ") FileOption { return core.WithHints(h) }\n\n");
        }
    }

    private void version() {
        ctx.writerDelegator().useFileWriter("version.go", "", w -> {
            w.l("// SDKVersion is the version stamped into the source: a release's version, or the 0.0.0 placeholder in the\n"
                    + "// repository. Go installs from a git tag, so a client reports the module version it was built with instead\n"
                    + "// (core.ModuleVersion), and SDKVersion only when the build information has none.\nconst SDKVersion = "
                    + Names.str(ctx.settings().version()) + "\n\n");
            w.l("// ModulePath is this SDK's module path, which core.ModuleVersion looks up in the build information.\n"
                    + "const ModulePath = " + Names.str(ctx.settings().module()) + "\n\n");
            w.l("// ModelVersion is the Caitlyn release the SDK was generated from (the highest @since in the model), sent as Caitlyn-Sdk-Model.\n");
            w.l("const ModelVersion = " + Names.str(facts.apiVersion) + "\n");
        });
    }

    /**
     * The wait helper for a watch whose wait ends on its thing's own status (an unattended run's,
     * ProcessingWatch.endsOnStatus), from wait_status.go.tmpl, written once per watch: it names the model's types for
     * that thing, so it is generated with them rather than kept in the hand-written runtime.
     */
    private final Set<String> statusWaits = new HashSet<>();

    private void statusWait(String watchName) {
        if (!statusWaits.add(watchName)) return;
        GoSettings s = ctx.settings();
        String thing = watchName.substring("Watch".length());
        List<String> words = Names.words(thing);
        String body = resource("wait_status.go.tmpl").replace("{{CORE}}", s.coreModule()).replace("{{PACKAGE}}", s.packageName())
                .replace("{{WATCH}}", watchName).replace("{{THING}}", thing).replace("{{LOWER}}", Names.lowerFirst(thing))
                .replace("{{WORDS}}", String.join(" ", words));
        ctx.fileManifest().writeFile("wait_" + String.join("_", words) + ".go", GoWriter.HEADER + body);
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
