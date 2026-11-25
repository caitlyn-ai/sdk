package ai.caitlyn.codegen.python;

import ai.caitlyn.codegen.model.CaitlynTraits;
import ai.caitlyn.codegen.model.ScopeTree;
import ai.caitlyn.codegen.model.SseEvents;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Collectors;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.Symbol;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.PaginationInfo;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.HttpErrorTrait;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.IdempotencyTokenTrait;
import software.amazon.smithy.model.traits.MediaTypeTrait;
import software.amazon.smithy.model.traits.ReadonlyTrait;
import software.amazon.smithy.model.traits.StreamingTrait;
import software.amazon.smithy.model.traits.TitleTrait;

/**
 * Writes the operation descriptions ({@code _operations.py}), the sync and async clients with one
 * resource class per namespace ({@code _client.py}), and the package files.
 */
final class ServiceGenerator {
    private static final String CORE = "caitlyn_core";

    private final GenerationContext ctx;
    private final ServiceShape service;
    private final Model model;
    private final software.amazon.smithy.model.shapes.ShapeId serviceId;
    private Map<String, List<ai.caitlyn.codegen.model.Ranges.Rule>> ranges;

    private Map<String, List<ai.caitlyn.codegen.model.Ranges.Rule>> ranges() {
        if (ranges == null) ranges = ai.caitlyn.codegen.model.Ranges.of(model, serviceId);
        return ranges;
    }
    private final PythonSettings settings;
    private final ModelFacts facts;
    private final software.amazon.smithy.codegen.core.SymbolProvider symbols;
    private final TypeHints hints;
    private final List<OperationInfo> ops = new ArrayList<>();
    private final Map<ShapeId, OperationInfo> byId = new LinkedHashMap<>();
    private final String title;
    private Optional<Upload> upload = Optional.empty();
    private final ScopeTree tree;

    ServiceGenerator(GenerationContext ctx, ServiceShape service) {
        this.ctx = ctx;
        this.service = service;
        this.model = ctx.model();
        this.serviceId = ctx.settings().service();
        this.settings = ctx.settings();
        this.facts = ctx.facts();
        this.symbols = ctx.symbolProvider();
        this.hints = new TypeHints(model, symbols, facts);
        this.title = service.getTrait(TitleTrait.class).map(TitleTrait::getValue).orElse(service.getId().getName());
        this.tree = ctx.facts().tree;
    }

    void run() {
        for (OperationShape op : new TreeSet<>(TopDownIndex.of(model).getContainedOperations(service))) {
            if (CaitlynTraits.omittedFromSdk(op)) {
                continue; // never generated into the public SDKs
            }
            OperationInfo info = new OperationInfo(model, service, op, settings);
            ops.add(info);
            byId.put(op.getId(), info);
        }
        writeOperations();
        writeErrorCodes();
        writeClient();
        writeVersion();
        writeAuth();
        writeInit();
        ctx.fileManifest().writeFile(settings.packageName() + "/py.typed", "");
        writePyproject();
        writeReadme();
    }

    private String module(String name) {
        return settings.module(name);
    }

    // ------------------------------------------------------------------ errors.py: ErrorCode

    /**
     * {@code ErrorCode}: an open enum with a member for every stable code the model lists ({@code @errorCodes}),
     * written into the errors module beside the error classes. It is a StrEnum, so {@code e.code == ErrorCode.NOT_FOUND}
     * and {@code e.code == "NOT_FOUND"} are the same check, and a code this SDK does not know yet still parses.
     */
    private void writeErrorCodes() {
        Map<String, StructureShape> codes = new TreeMap<>();
        for (StructureShape e : serviceErrors()) {
            CaitlynTraits.node(e, CaitlynTraits.ERROR_CODES).flatMap(Node::asArrayNode).ifPresent(a -> a.getElements()
                    .forEach(c -> codes.putIfAbsent(c.expectStringNode().getValue(), e)));
        }
        if (codes.isEmpty()) {
            return;
        }
        Symbol any = symbols.toSymbol(codes.values().iterator().next());
        ctx.writerDelegator().useFileWriter(any.getDefinitionFile(), any.getNamespace(), w -> {
            w.importFrom("caitlyn_core", "OpenEnum");
            w.write("");
            w.write("class ErrorCode(OpenEnum):");
            w.indent();
            w.write("$D\n", "The stable error codes the API documents. `e.code` is one of these, or a code this SDK does not know "
                    + "yet (`ErrorCode(\"…\")` keeps it, with `is_known` False). A member is its own string, so "
                    + "`e.code == ErrorCode.NOT_FOUND` and `e.code == \"NOT_FOUND\"` are the same check. Each code's page is "
                    + "https://build.caitlyn.ai/errors/{code}.");
            codes.forEach((code, e) -> {
                w.write("$L = $L", code, Names.pyString(code));
                w.write("$D", "Raised as " + symbols.toSymbol(e).getName() + " (" + e.expectTrait(HttpErrorTrait.class).getCode() + ").");
            });
            ai.caitlyn.codegen.model.SdkErrorCodes.CODES.forEach((code, what) -> {
                if (!codes.containsKey(code)) {
                    w.write("$L = $L", code, Names.pyString(code));
                    w.write("$D", "Raised by the SDK itself, with status 0. " + what);
                }
            });
            w.dedent();
        });
    }

    // ------------------------------------------------------------------ _operations.py

    private void writeOperations() {
        ctx.writerDelegator().useFileWriter(settings.file("_operations"), module("_operations"), w -> {
            w.write("$D\n", "Operation descriptions, read by caitlyn-core to serialise requests and read responses. Internal.");
            w.importFrom("typing", "Final");
            w.importFrom(CORE, "Member");
            w.importFrom(CORE, "OperationSpec");
            for (OperationInfo o : ops) {
                writeSpec(w, o);
            }
            for (OperationInfo o : ops) {
                if (o.kind == OperationInfo.Kind.STREAM) {
                    writeDecoder(w, o);
                }
            }
            writeCodeErrors(w);
            writeSyncApi(w);
        });
    }

    private void writeSpec(PythonWriter w, OperationInfo o) {
        w.write("$L: Final = OperationSpec(", o.constant);
        w.indent();
        w.write("name=$L,", Names.pyString(o.name));
        w.write("method=$L,", Names.pyString(o.http.getMethod()));
        w.write("uri=$L,", Names.pyString(o.http.getUri().toString()));
        w.write("code=$L,", o.http.getCode());
        w.write("members=(");
        w.indent();
        for (OperationInfo.Param p : o.params) {
            List<String> args = new ArrayList<>(List.of(Names.pyString(p.name()), Names.pyString(p.wire()), Names.pyString(p.location())));
            CaitlynTraits.since(p.member()).ifPresent(v -> args.add("since=" + Names.pyString(v)));
            if (p.member().hasTrait(IdempotencyTokenTrait.class)) {
                args.add("idempotency_token=True");
            }
            w.write("Member($L),", String.join(", ", args));
        }
        w.dedent();
        w.write("),");
        List<String> headers = new ArrayList<>();
        HttpBindingIndex.of(model).getResponseBindings(o.op).forEach((name, b) -> {
            if (b.getLocation() == HttpBinding.Location.HEADER) {
                headers.add("(" + Names.pyString(name) + ", " + Names.pyString(b.getLocationName()) + ")");
            }
        });
        if (!headers.isEmpty()) {
            w.write("response_headers=($L,),", String.join(", ", headers));
        }
        Map<Integer, String> errors = new LinkedHashMap<>();
        for (Shape e : serviceErrors()) {
            e.getTrait(HttpErrorTrait.class).ifPresent(t -> {
                Symbol s = symbols.toSymbol(e);
                w.importFrom(s.getNamespace(), s.getName());
                errors.putIfAbsent(t.getCode(), s.getName());
            });
        }
        w.write("errors={$L},", errors.entrySet().stream().map(e -> e.getKey() + ": " + e.getValue()).collect(Collectors.joining(", ")));
        w.write("retry_safe=$L,", o.retrySafe ? "True" : "False");
        o.since.ifPresent(v -> w.write("since=$L,", Names.pyString(v)));
        // The @range rules the request carries (PROTOCOL.md 3), checked before sending
        List<ai.caitlyn.codegen.model.Ranges.Rule> rules = ranges().getOrDefault(o.op.getId().getName(), List.of());
        if (!rules.isEmpty()) {
            w.write("ranges=($L,),", rules.stream().map(r -> "(" + Names.pyString(r.where()) + ", " + Names.pyString(r.path()) + ", "
                + r.min().map(ai.caitlyn.codegen.model.Ranges::number).orElse("None") + ", "
                + r.max().map(ai.caitlyn.codegen.model.Ranges::number).orElse("None") + ")").collect(Collectors.joining(", ")));
        }
        w.write("stability=$L,", Names.pyString(o.stability));
        if (o.kind == OperationInfo.Kind.STREAM) {
            w.write("streaming=True,");
        }
        if (facts.payloads.containsKey(o.output.getId())) {
            w.write("thing=True,");
        }
        payloadMediaType(o).ifPresent(mt -> w.write("payload_media_type=$L,", Names.pyString(mt)));
        w.dedent();
        w.write(")\n");
    }

    private Optional<String> payloadMediaType(OperationInfo o) {
        return o.params.stream().filter(p -> p.binding().getLocation() == HttpBinding.Location.PAYLOAD).findFirst()
                .flatMap(p -> model.expectShape(p.member().getTarget()).getTrait(MediaTypeTrait.class)).map(MediaTypeTrait::getValue);
    }

    /** The SSE union, its event classes, and the final result type F of the stream. */
    private record StreamTypes(UnionShape union, String unionName, String finalType, Optional<MemberShape> finalMember, Optional<String> errorEvent) {}

    private StreamTypes streamTypes(OperationInfo o, PythonWriter w) {
        ObjectNode sse = o.sse.orElseThrow();
        UnionShape union = model.expectShape(ShapeId.from(sse.expectStringMember("events").getValue()), UnionShape.class);
        Symbol unionSymbol = symbols.toSymbol(union);
        w.importFrom(unionSymbol.getNamespace(), unionSymbol.getName());
        Optional<String> finalName = sse.getStringMember("final").map(s -> s.getValue())
                .or(() -> Optional.ofNullable(settings.sseFinal().get(o.name)));
        Optional<MemberShape> finalMember = finalName.map(n -> union.getMember(n)
                .orElseThrow(() -> new CodegenException(o.op.getId() + ": @sseEvents final member " + n + " is not in " + union.getId())));
        String finalType = "None";
        if (finalMember.isPresent()) {
            StructureShape target = model.expectShape(finalMember.get().getTarget(), StructureShape.class);
            if (target.getAllMembers().size() == 1) {
                finalType = hints.of(target.getAllMembers().values().iterator().next(), TypeHints.Mode.MODEL, w);
            } else {
                finalType = facts.eventClassNames.get(finalMember.get().getId());
                w.importFrom(unionSymbol.getNamespace(), finalType);
            }
        }
        Optional<String> errorEvent = facts.failureMember(union.getId()).map(m -> facts.eventClassNames.get(m.getId()));
        return new StreamTypes(union, unionSymbol.getName(), finalType, finalMember, errorEvent);
    }

    private void writeDecoder(PythonWriter w, OperationInfo o) {
        StreamTypes t = streamTypes(o, w);
        w.importFrom(CORE, "EventDecoder");
        String fn = "_" + Names.snake(o.name) + "_final";
        String eventsModule = symbols.toSymbol(t.union).getNamespace();
        w.write("");
        w.write("def $L(event: $L) -> $L:", fn, t.unionName, t.finalType + (t.finalType.equals("None") ? "" : " | None"));
        w.indent();
        if (t.finalMember.isEmpty()) {
            w.write("return None");
        } else {
            String cls = facts.eventClassNames.get(t.finalMember.get().getId());
            w.importFrom(eventsModule, cls);
            StructureShape target = model.expectShape(t.finalMember.get().getTarget(), StructureShape.class);
            if (target.getAllMembers().size() == 1) {
                String attr = Names.field(target.getAllMembers().values().iterator().next().getMemberName());
                w.write("return event.$L if isinstance(event, $L) else None", attr, cls);
            } else {
                w.write("return event if isinstance(event, $L) else None", cls);
            }
        }
        w.dedent();
        w.write("\n");
        String types = Names.upperSnake(t.unionName) + "_TYPES";
        w.importFrom(eventsModule, types);
        t.errorEvent.ifPresent(e -> w.importFrom(eventsModule, e));
        w.write("$L_EVENTS: Final = EventDecoder[$L, $L]($L, $L, $L, has_final=$L)\n", o.constant, t.unionName, t.finalType, types, fn,
                t.errorEvent.orElse("None"), t.finalMember.isPresent() ? "True" : "False");
    }

    // ------------------------------------------------------------------ _operations.py: codes and the sync helper's API

    /** {@code CODE_ERRORS}: each stable code an error shape lists ({@code @errorCodes}) to its class, for a job's failure. */
    private void writeCodeErrors(PythonWriter w) {
        Map<String, String> codes = new TreeMap<>();
        for (StructureShape e : serviceErrors()) {
            Symbol s = symbols.toSymbol(e);
            CaitlynTraits.node(e, CaitlynTraits.ERROR_CODES).flatMap(Node::asArrayNode).ifPresent(a -> a.getElements().forEach(c -> {
                w.importFrom(s.getNamespace(), s.getName());
                codes.putIfAbsent(c.expectStringNode().getValue(), s.getName());
            }));
        }
        w.importFrom(CORE, "CaitlynError");
        w.write("");
        w.write("CODE_ERRORS: Final[dict[str, type[CaitlynError]]] = {");
        w.indent();
        codes.forEach((k, v) -> w.write("$L: $L,", Names.pyString(k), v));
        w.dedent();
        w.write("}");
        w.write("\"\"\"Each stable code to the error class that carries it: a failed job raises its code as this class.\"\"\"");
    }

    private static final List<String> SYNC_OPS = List.of("CreateIngestionBatch", "BatchCreateIngestionBatchItems", "GetIngestionBatch",
            "UpdateIngestionBatchItem", "StartIngestionBatch", "ListIngestionBatchItems", "CreateIngestionBatchUploadPolicy",
            "CompleteIngestionBatchUploads", "CancelIngestionBatch", "ListDocuments", "EstimateIngestion", "WatchKnowledgeBase");
    private static final List<String> SYNC_FIELDS = List.of("create", "add_items", "get", "resolve_item", "start", "list_items",
            "renew_policy", "complete", "cancel", "list_documents", "estimate", "watch");

    /** The operations the {@code ingestion.sync} helper is made from (PROTOCOL.md 15), when the model has them all. */
    private Optional<Map<String, OperationInfo>> syncOps() {
        Map<String, OperationInfo> found = new LinkedHashMap<>();
        for (String n : SYNC_OPS) {
            byName(n).ifPresent(o -> found.put(n, o));
        }
        if (found.isEmpty()) {
            return Optional.empty();
        }
        if (found.size() != SYNC_OPS.size()) {
            List<String> missing = SYNC_OPS.stream().filter(n -> !found.containsKey(n)).toList();
            throw new CodegenException("The ingestion.sync helper needs " + missing);
        }
        return Optional.of(found);
    }

    private void writeSyncApi(PythonWriter w) {
        syncOps().ifPresent(found -> {
            w.importFrom(CORE, "SyncApi");
            String batch = typeOf(found.get("GetIngestionBatch").output, w);
            String estimate = typeOf(found.get("EstimateIngestion").output, w);
            w.write("");
            w.write("SYNC_API: Final = SyncApi(");
            w.indent();
            for (int i = 0; i < SYNC_OPS.size(); i++) {
                w.write("$L=$L,", SYNC_FIELDS.get(i), found.get(SYNC_OPS.get(i)).constant);
            }
            w.write("watch_events=$L_EVENTS,", found.get("WatchKnowledgeBase").constant);
            w.write("batch=$L,", batch);
            w.write("item=$L,", syncItemType(found, w));
            w.write("estimate_result=$L,", estimate);
            w.write("codes=CODE_ERRORS,");
            w.dedent();
            w.write(")");
            w.write("\"\"\"The operations the `ingestion.sync` helper is made from.\"\"\"");
        });
    }

    private String syncItemType(Map<String, OperationInfo> found, PythonWriter w) {
        PaginationInfo p = found.get("ListIngestionBatchItems").pagination.orElseThrow();
        ListShape list = (ListShape) model.expectShape(p.getItemsMemberPath().get(0).getTarget());
        return hints.of(list.getMember(), TypeHints.Mode.MODEL, w);
    }

    // ------------------------------------------------------------------ _client.py: the scopes (PROTOCOL.md 10)

    private record Upload(OperationInfo presigned, Map<OperationInfo, String> targets) {}

    private Optional<Upload> uploads() {
        OperationInfo presigned = null;
        Map<OperationInfo, String> targets = new LinkedHashMap<>();
        for (OperationInfo o : ops) {
            if (o.op.hasTrait(CaitlynTraits.PRESIGNED_UPLOAD) || "".equals(settings.uploads().get(o.name))) {
                presigned = o;
            }
            Optional<String> member = CaitlynTraits.stringMember(o.op, CaitlynTraits.UPLOAD_TARGET, "member")
                    .or(() -> Optional.ofNullable(settings.uploads().get(o.name)).filter(s -> !s.isEmpty()));
            member.ifPresent(m -> targets.put(o, m));
        }
        if (presigned == null) {
            if (!targets.isEmpty()) {
                throw new CodegenException("Upload targets " + targets.keySet().stream().map(t -> t.name).toList() + " but no presigned upload operation");
            }
            return Optional.empty();
        }
        for (String m : List.of("fileName", "contentType", "byteSize", "sha256")) {
            if (presigned.param(m).isEmpty()) {
                throw new CodegenException(presigned.op.getId() + " is a presigned upload but its input has no " + m);
            }
        }
        for (String m : List.of("id", "uploadUrl", "uploadMethod", "requiredHeaders")) {
            if (shapeOf(presigned.output).getMember(m).isEmpty()) {
                throw new CodegenException(presigned.op.getId() + " is a presigned upload but its output has no " + m);
            }
        }
        return Optional.of(new Upload(presigned, targets));
    }

    private OperationInfo info(ScopeTree.Method m) {
        OperationInfo o = byId.get(m.operation.getId());
        if (o == null) {
            throw new CodegenException(m.operation.getId() + " is placed in the scope tree but not generated");
        }
        return o;
    }

    // Class names: the node's place in words (a scope by its collection's singular), shortened to the shortest ending
    // that is unique, with a suffix saying what it is: KnowledgeBaseScope, DocumentsCollection, IngestionNamespace.

    private final Map<ScopeTree.Node, String> classes = new LinkedHashMap<>();
    private final Map<String, String> methodClasses = new LinkedHashMap<>();
    private final Map<ScopeTree.Node, ScopeTree.Node> createdScopes = new LinkedHashMap<>();

    private static List<String> segments(ScopeTree.Node n) {
        if (n.parent == null) {
            return new ArrayList<>();
        }
        List<String> out;
        if (n.kind == ScopeTree.Kind.SCOPE && n.parent.kind == ScopeTree.Kind.COLLECTION) {
            out = segments(n.parent.parent);
            out.add(n.parent.singular.isEmpty() ? n.name : n.parent.singular);
        } else {
            out = segments(n.parent);
            out.add(n.name);
        }
        return out;
    }

    private static String pascal(List<String> segs) {
        return segs.stream().map(s -> Character.toUpperCase(s.charAt(0)) + s.substring(1)).collect(Collectors.joining());
    }

    private void nameClasses() {
        Map<String, List<String>> segs = new LinkedHashMap<>();
        Map<String, String> suffix = new LinkedHashMap<>();
        Map<String, ScopeTree.Node> nodeOf = new LinkedHashMap<>();
        for (ScopeTree.Node n : tree.root.walk()) {
            if (n.kind == ScopeTree.Kind.ROOT) {
                continue;
            }
            String key = "node:" + n.path();
            segs.put(key, segments(n));
            suffix.put(key, switch (n.kind) {
                case SCOPE -> "Scope";
                case COLLECTION -> "Collection";
                default -> "Namespace";
            });
            nodeOf.put(key, n);
            for (ScopeTree.Method m : n.methods) {
                if (m.estimate.isPresent()) {
                    List<String> s = segments(n);
                    s.add(m.name);
                    segs.put(methodKey(n, m.name), s);
                    suffix.put(methodKey(n, m.name), "Method");
                }
            }
            if (isSyncHome(n)) {
                List<String> s = segments(n);
                s.add("sync");
                segs.put(methodKey(n, "sync"), s);
                suffix.put(methodKey(n, "sync"), "Method");
            }
            if (isUploadHome(n)) {
                List<String> s = segments(n);
                s.add("upload");
                segs.put(methodKey(n, "upload"), s);
                suffix.put(methodKey(n, "upload"), "Method");
            }
        }
        java.util.Set<String> taken = new java.util.HashSet<>(List.of("Caitlyn", "AsyncCaitlyn"));
        model.shapes().forEach(s -> taken.add(s.getId().getName()));
        taken.addAll(facts.eventClassNames.values());
        Map<String, Integer> k = new LinkedHashMap<>();
        // A job's class names its place too (DocumentsCreateMethod, not CreateMethod): it is read as a type, alone.
        segs.keySet().forEach(key -> k.put(key, "Method".equals(suffix.get(key)) ? Math.min(2, segs.get(key).size()) : 1));
        while (true) {
            Map<String, List<String>> byName = new LinkedHashMap<>();
            for (String key : segs.keySet()) {
                List<String> s = segs.get(key);
                String name = pascal(s.subList(Math.max(0, s.size() - k.get(key)), s.size())) + suffix.get(key);
                byName.computeIfAbsent(name, x -> new ArrayList<>()).add(key);
            }
            boolean changed = false;
            for (Map.Entry<String, List<String>> e : byName.entrySet()) {
                if (e.getValue().size() > 1 || taken.contains(e.getKey()) || taken.contains("Created" + e.getKey())) {
                    for (String key : e.getValue()) {
                        if (k.get(key) < segs.get(key).size()) {
                            k.put(key, k.get(key) + 1);
                            changed = true;
                        }
                    }
                }
            }
            if (!changed) {
                for (Map.Entry<String, List<String>> e : byName.entrySet()) {
                    if (e.getValue().size() > 1) {
                        throw new CodegenException("Two client classes would be named " + e.getKey() + ": " + e.getValue());
                    }
                    String key = e.getValue().get(0);
                    if (nodeOf.containsKey(key)) {
                        classes.put(nodeOf.get(key), e.getKey());
                    } else {
                        methodClasses.put(key, e.getKey());
                    }
                }
                return;
            }
        }
    }

    private static String methodKey(ScopeTree.Node n, String method) {
        return "method:" + n.path() + "#" + method;
    }

    private String cls(ScopeTree.Node n, boolean async) {
        return (async ? "Async" : "") + classes.get(n);
    }

    private String methodCls(ScopeTree.Node n, String method, boolean async) {
        return (async ? "Async" : "") + methodClasses.get(methodKey(n, method));
    }

    private String createdCls(ScopeTree.Node scope, boolean async) {
        return (async ? "Async" : "") + "Created" + classes.get(scope);
    }

    private static String pyName(String modelName) {
        return Names.member(Names.snake(modelName));
    }

    /** Where the ingestion.sync helper lives: the plain namespace that holds the ingestion batches' collection. */
    private boolean isSyncHome(ScopeTree.Node n) {
        if (syncOps().isEmpty() || n.kind != ScopeTree.Kind.NAMESPACE) {
            return false;
        }
        return n.children.values().stream().anyMatch(c -> c.kind == ScopeTree.Kind.COLLECTION
                && c.methods.stream().anyMatch(m -> m.operation.getId().getName().equals("CreateIngestionBatch")));
    }

    /** Where batch.upload lives: the scope of one ingestion batch, the one StartIngestionBatch is called on. */
    private boolean isUploadHome(ScopeTree.Node n) {
        return syncOps().isPresent() && n.kind == ScopeTree.Kind.SCOPE && n.watch.isPresent()
                && n.methods.stream().anyMatch(m -> m.operation.getId().getName().equals("StartIngestionBatch"));
    }

    /** The nearest scope at or above a node that can be watched: the thing a call there starts work on. */
    private static Optional<ScopeTree.Node> watchedScope(ScopeTree.Node n) {
        for (ScopeTree.Node cur = n; cur != null; cur = cur.parent) {
            if (cur.kind == ScopeTree.Kind.SCOPE && cur.watch.isPresent()) {
                return Optional.of(cur);
            }
        }
        return Optional.empty();
    }

    /** A scope's method by name. */
    private static Optional<ScopeTree.Method> method(ScopeTree.Node n, String name) {
        return n.methods.stream().filter(m -> m.name.equals(name)).findFirst();
    }

    /** The scope that a collection's create returns, when the create makes one. */
    private Optional<ScopeTree.Node> createdScope(ScopeTree.Method m) {
        return m.creates.map(c -> c.collection().scope);
    }

    private void writeClient() {
        nameClasses();
        this.upload = uploads();
        // The scopes a create returns, each with a class carrying the response's fields.
        for (ScopeTree.Node n : tree.root.walk()) {
            for (ScopeTree.Method m : n.methods) {
                createdScope(m).ifPresent(s -> createdScopes.put(s, s));
            }
        }
        ctx.writerDelegator().useFileWriter(settings.file("_client"), module("_client"), w -> {
            w.write("$D\n", "The " + title + " clients, `Caitlyn` (synchronous) and `AsyncCaitlyn`, as scopes: `caitlyn.knowledge_bases(kb_id)`"
                    + "\nis one knowledge base, and every call about it hangs off it (PROTOCOL.md 10).");
            w.importModule("httpx");
            w.importFrom("typing", "Any");
            w.importFrom("collections.abc", "Mapping");
            for (boolean async : new boolean[] {false, true}) {
                for (ScopeTree.Node n : tree.root.walk()) {
                    if (n.kind == ScopeTree.Kind.ROOT) {
                        continue;
                    }
                    writeNode(w, n, async);
                    if (createdScopes.containsKey(n)) {
                        // One class per scope a create returns, from the first create that makes it (CreateConversation
                        // is placed on every version scope).
                        tree.root.walk().stream().flatMap(h -> h.methods.stream()).filter(m -> createdScope(m).filter(n::equals).isPresent())
                                .findFirst().ifPresent(m -> writeCreated(w, n, m, async));
                    }
                    for (ScopeTree.Method m : n.methods) {
                        if (m.estimate.isPresent()) {
                            writeJobClass(w, n, m, async);
                        }
                    }
                    if (isSyncHome(n)) {
                        writeSyncClass(w, n, async);
                    }
                    if (isUploadHome(n)) {
                        writeUploadClass(w, n, async);
                    }
                    if (n.kind == ScopeTree.Kind.SCOPE && n.watch.isPresent()) {
                        writeFollow(w, n, async);
                    }
                }
            }
            writeClientClass(w, false);
            writeClientClass(w, true);
        });
    }

    /** Docs for a node's class: where it is in the client, and what hangs off it. */
    private String nodeDocs(ScopeTree.Node n) {
        String where = "`" + pyPath(n) + "`";
        String what = switch (n.kind) {
            case SCOPE -> n.resource.flatMap(CaitlynPythonCodegen::docs).map(d -> firstSentence(d)).orElse("A scope.");
            case COLLECTION -> "Call it with " + n.identifiers.stream().map(i -> pyName(i.name())).collect(Collectors.joining(" and "))
                    + " for one of them" + (n.methods.isEmpty() ? "." : "; the calls on the collection are below.");
            default -> "A group of calls.";
        };
        return where + ": " + what + (n.kind == ScopeTree.Kind.SCOPE ? "\n\nMaking it sends nothing: a scope is a reference, and each call on it fills in its identifiers." : "");
    }

    private static String firstSentence(String doc) {
        String one = doc.replace("\n", " ");
        int dot = one.indexOf(". ");
        return dot < 0 ? one : one.substring(0, dot + 1);
    }

    /** The node's place in the Python client: caitlyn.knowledge_bases(knowledge_base_id).documents. */
    private static String pyPath(ScopeTree.Node n) {
        if (n.parent == null) {
            return "caitlyn";
        }
        String up = pyPath(n.parent);
        if (n.kind == ScopeTree.Kind.SCOPE && n.parent.kind == ScopeTree.Kind.COLLECTION) {
            return up + "(" + n.parent.identifiers.stream().map(i -> pyName(i.name())).collect(Collectors.joining(", ")) + ")";
        }
        return up + "." + Names.snake(n.name);
    }

    /** The names a node's class defines, so an identifier or forwarded field never hides one. */
    private java.util.Set<String> namesOn(ScopeTree.Node n) {
        java.util.Set<String> out = new java.util.HashSet<>();
        n.children.keySet().forEach(c -> out.add(Names.snake(c)));
        n.methods.forEach(m -> out.add(Names.snake(m.name)));
        if (n.kind == ScopeTree.Kind.SCOPE && n.watch.isPresent()) {
            out.addAll(List.of("watch", "wait"));
            if (n.watch.get().filter().filter("batch"::equals).isPresent()) {
                out.add("planned");
            }
        }
        if (isSyncHome(n)) {
            out.add("sync");
        }
        if (isUploadHome(n)) {
            out.add("upload");
        }
        if (upload.isPresent() && n.methods.stream().anyMatch(m -> m.operation.getId().equals(upload.get().presigned.op.getId()))) {
            out.add("send");
        }
        return out;
    }

    private void writeNode(PythonWriter w, ScopeTree.Node n, boolean async) {
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        w.importFrom(CORE, core);
        w.importFrom(settings.packageName(), "_operations");
        w.write("class $L:", cls(n, async));
        w.indent();
        w.write("$D\n", nodeDocs(n));
        for (Map.Entry<String, ScopeTree.Node> c : n.children.entrySet()) {
            w.write("$L: $L", Names.snake(c.getKey()), cls(c.getValue(), async));
        }
        for (ScopeTree.Method m : n.methods) {
            if (m.estimate.isPresent()) {
                w.write("$L: $L", Names.snake(m.name), methodCls(n, m.name, async));
            }
        }
        if (isSyncHome(n)) {
            w.write("sync: $L", methodCls(n, "sync", async));
        }
        if (isUploadHome(n)) {
            w.write("upload: $L", methodCls(n, "upload", async));
        }
        w.write("");
        w.write("def __init__(self, core: $L, ids: Mapping[str, Any]) -> None:", core);
        w.indent();
        w.write("self._core = core");
        w.write("self._ids: dict[str, Any] = dict(ids)");
        for (Map.Entry<String, ScopeTree.Node> c : n.children.entrySet()) {
            w.write("self.$L = $L(core, $L)", Names.snake(c.getKey()), cls(c.getValue(), async), idsWithFixed(c.getValue()));
        }
        for (ScopeTree.Method m : n.methods) {
            if (m.estimate.isPresent()) {
                w.write("self.$L = $L(core, self._ids)", Names.snake(m.name), methodCls(n, m.name, async));
            }
        }
        if (isSyncHome(n)) {
            w.write("self.sync = $L(core, self._ids)", methodCls(n, "sync", async));
        }
        if (isUploadHome(n)) {
            w.write("self.upload = $L(core, self._ids)", methodCls(n, "upload", async));
        }
        w.dedent();
        if (n.kind == ScopeTree.Kind.COLLECTION && n.scope != null) {
            List<String> params = new ArrayList<>();
            List<String> entries = new ArrayList<>();
            for (ScopeTree.Identifier i : n.identifiers) {
                params.add(pyName(i.name()) + ": " + identifierType(n.scope, i.name(), w));
                entries.add(Names.pyString(i.name()) + ": " + pyName(i.name()));
            }
            w.write("");
            writeDef(w, false, "__call__", params, cls(n.scope, async));
            w.indent();
            w.write("$D", "The scope of one: `" + pyPath(n.scope) + "`. Sends nothing.");
            w.write("return $L(self._core, {**self._ids, $L})", cls(n.scope, async), String.join(", ", entries));
            w.dedent();
        }
        if (n.kind == ScopeTree.Kind.SCOPE) {
            writeIdentifierProperties(w, n);
        }
        java.util.Set<String> done = new java.util.HashSet<>();
        for (ScopeTree.Method m : n.methods) {
            if (m.estimate.isPresent() || !done.add(m.name)) {
                continue;
            }
            w.write("");
            writeMethod(w, n, m, async, Names.snake(m.name));
        }
        if (upload.isPresent() && n.methods.stream().anyMatch(m -> m.operation.getId().equals(upload.get().presigned.op.getId()))) {
            w.write("");
            writeUploadSend(w, n, upload.get().presigned, async);
        }
        if (n.kind == ScopeTree.Kind.SCOPE && n.watch.isPresent()) {
            writeWatchAndWait(w, n, async);
        }
        w.dedent();
        w.write("\n");
    }

    /** The ids a child is made with: this node's, plus a named scope's fixed identifier ({@code agent.draft}). */
    private String idsWithFixed(ScopeTree.Node child) {
        List<String> fixed = child.identifiers.stream().filter(i -> i.fixed().isPresent())
                .map(i -> Names.pyString(i.name()) + ": " + Names.pyString(i.fixed().get())).toList();
        return fixed.isEmpty() ? "self._ids" : "{**self._ids, " + String.join(", ", fixed) + "}";
    }

    /** An identifier's Python type, from the resource's identifier shape (str for nearly all). */
    private String identifierType(ScopeTree.Node scope, String identifier, PythonWriter w) {
        Optional<ShapeId> target = scope.resource.flatMap(r -> Optional.ofNullable(r.getIdentifiers().get(identifier)));
        if (target.isEmpty()) {
            return "str";
        }
        Shape s = model.expectShape(target.get());
        return s.isStringShape() ? "str" : hints.of(s, TypeHints.Mode.INPUT, w);
    }

    private void writeIdentifierProperties(PythonWriter w, ScopeTree.Node n) {
        if (n.identifiers.isEmpty()) {
            return;
        }
        java.util.Set<String> names = namesOn(n);
        ScopeTree.Identifier last = n.identifiers.get(n.identifiers.size() - 1);
        Map<String, String> props = new LinkedHashMap<>();
        if (n.resource.isPresent() && n.resource.get().getIdentifiers().containsKey(last.name())) {
            props.put("id", last.name());
        }
        for (ScopeTree.Identifier i : n.identifiers) {
            props.putIfAbsent(pyName(i.name()), i.name());
        }
        for (Map.Entry<String, String> p : props.entrySet()) {
            if (names.contains(p.getKey())) {
                continue;
            }
            w.write("");
            w.write("@property");
            w.write("def $L(self) -> $L:", p.getKey(), identifierType(n, p.getValue(), w));
            w.indent();
            w.write("$D", "The `" + p.getValue() + "` this scope holds.");
            w.write("return self._ids[$S]", p.getValue());
            w.dedent();
        }
    }

    // ------------------------------------------------------------------ one method

    /** A method's Python parameters, the statements before its call, and its request parameters. */
    private record Call(List<String> params, List<String> setup, String dict, List<String> docArgs) {}

    private boolean isReaders(MemberShape m) {
        Shape t = model.expectShape(m.getTarget());
        return t.isStructureShape() && t.getId().getName().equals("Readers") && t.asStructureShape().flatMap(s -> s.getMember("kind")).isPresent();
    }

    /**
     * A list of upload references ({uploadId}) on a call whose scope the presigned upload's purpose can name: the purpose,
     * as a Python dict over the scope's identifiers. SendMessage's attachments give {"conversationId": …}, a member of
     * the purpose the scope fills; CreateUnattendedRun's give {"unattendedRun": {"agentId": …, "version": …}}, a member
     * made of members the scope fills. Empty for any other member.
     */
    private Optional<String> attachmentsPurpose(ScopeTree.Method m, OperationInfo.Param p) {
        return attachmentsPurposeMember(m, p).map(f -> "{" + Names.pyString(f) + ": " + idExpr(m, f) + "}").or(() -> {
            if (attachmentsList(p).isEmpty()) {
                return Optional.empty();
            }
            StructureShape ps = model.expectShape(upload.get().presigned.param("purpose").orElseThrow().member().getTarget(), StructureShape.class);
            java.util.Set<String> filled = new java.util.HashSet<>(m.fills.stream().map(ScopeTree.Fill::member).toList());
            for (MemberShape pm : ps.getAllMembers().values()) {
                if (!(model.expectShape(pm.getTarget()) instanceof StructureShape st) || st.getAllMembers().isEmpty()) {
                    continue;
                }
                if (!filled.containsAll(st.getAllMembers().keySet())) {
                    continue;
                }
                String inner = st.getAllMembers().keySet().stream().map(k -> Names.pyString(k) + ": " + idExpr(m, k)).collect(java.util.stream.Collectors.joining(", "));
                return Optional.of("{" + Names.pyString(pm.getMemberName()) + ": {" + inner + "}}");
            }
            return Optional.empty();
        });
    }

    /** The scope's identifier that fills an input member, as Python reads it. */
    private static String idExpr(ScopeTree.Method m, String member) {
        String ident = m.fills.stream().filter(f -> f.member().equals(member)).findFirst().map(ScopeTree.Fill::identifier).orElse(member);
        return "self._ids[" + Names.pyString(ident) + "]";
    }

    /** The member is a list of upload references ({uploadId}) and there is a presigned upload with a purpose. */
    private Optional<OperationInfo.Param> attachmentsList(OperationInfo.Param p) {
        if (upload.isEmpty() || upload.get().presigned.param("purpose").isEmpty()) {
            return Optional.empty();
        }
        Shape t = model.expectShape(p.member().getTarget());
        if (!t.isListShape()) {
            return Optional.empty();
        }
        Shape item = model.expectShape(((ListShape) t).getMember().getTarget());
        if (!item.isStructureShape() || item.asStructureShape().get().getMember("uploadId").isEmpty() || item.getAllMembers().size() != 1) {
            return Optional.empty();
        }
        return Optional.of(p);
    }

    /** The member of the purpose a scope fills directly (SendMessage: conversationId). */
    private Optional<String> attachmentsPurposeMember(ScopeTree.Method m, OperationInfo.Param p) {
        if (upload.isEmpty()) {
            return Optional.empty();
        }
        Shape t = model.expectShape(p.member().getTarget());
        if (!t.isListShape()) {
            return Optional.empty();
        }
        Shape item = model.expectShape(((ListShape) t).getMember().getTarget());
        if (!item.isStructureShape() || item.asStructureShape().get().getMember("uploadId").isEmpty() || item.getAllMembers().size() != 1) {
            return Optional.empty();
        }
        Optional<OperationInfo.Param> purpose = upload.get().presigned.param("purpose");
        if (purpose.isEmpty()) {
            return Optional.empty();
        }
        StructureShape ps = model.expectShape(purpose.get().member().getTarget(), StructureShape.class);
        return m.fills.stream().map(ScopeTree.Fill::member).filter(f -> ps.getMember(f).isPresent()).findFirst();
    }

    private Optional<String> topUpload(OperationInfo o) {
        return upload.flatMap(u -> Optional.ofNullable(u.targets.get(o))).filter(t -> !t.contains("."));
    }

    private Optional<String> nestedUpload(OperationInfo o) {
        return upload.flatMap(u -> Optional.ofNullable(u.targets.get(o))).filter(t -> t.contains("."));
    }

    /**
     * The parameters a method takes: the leading identifiers under {@code core}, then a file for an upload target, or
     * else the one required member left (positionally: {@code fill_in(keys)}, {@code send(message)}), then the rest by
     * keyword. The members the scope fills are not parameters.
     */
    private Call call(ScopeTree.Method m, OperationInfo o, PythonWriter w, boolean async, Optional<String> describeFile) {
        List<String> params = new ArrayList<>();
        List<String> setup = new ArrayList<>();
        List<String> docArgs = new ArrayList<>();
        Map<String, String> values = new LinkedHashMap<>();
        for (String id : m.leading) {
            params.add(pyName(id) + ": str");
        }
        for (ScopeTree.Fill f : m.fills) {
            String expr = m.leading.contains(f.identifier()) ? pyName(f.identifier()) : "self._ids[" + Names.pyString(f.identifier()) + "]";
            if (f.trimSlashes()) {
                w.importFrom(CORE, "trim_slashes");
                expr = "trim_slashes(" + expr + ")";
            }
            values.put(f.member(), expr);
        }
        List<OperationInfo.Param> rest = o.params.stream().filter(p -> !m.fills(p.member().getMemberName())).toList();
        Optional<String> top = topUpload(o);
        Optional<String> positional = Optional.empty();
        if (top.isPresent() || describeFile.isPresent()) {
            w.importFrom(CORE, "FileInput");
            params.add(top.isPresent() ? "file: FileInput | None = None" : "file: FileInput");
            docArgs.add("    file: the file, an `UploadFile` (`from_path`, `from_bytes`, `from_stream`) or a path"
                    + (top.isPresent() ? ". Or pass `" + o.param(top.get()).orElseThrow().name() + "`, an upload already sent." : "."));
        } else {
            List<OperationInfo.Param> required = rest.stream().filter(p -> p.member().isRequired()
                    && p.binding().getLocation() != HttpBinding.Location.HEADER && !p.member().hasTrait(IdempotencyTokenTrait.class)).toList();
            if (required.size() == 1) {
                positional = Optional.of(required.get(0).member().getMemberName());
            }
        }
        List<String> keyword = new ArrayList<>();
        List<String> optional = new ArrayList<>();
        for (OperationInfo.Param p : rest) {
            String member = p.member().getMemberName();
            if (describeFile.filter(member::equals).isPresent()) {
                continue;
            }
            if (p.binding().getLocation() == HttpBinding.Location.PAYLOAD && model.expectShape(p.member().getTarget()).hasTrait(StreamingTrait.class)) {
                throw new CodegenException(o.op.getId() + ": streaming request payloads are not supported yet");
            }
            String type = hints.of(p.member(), TypeHints.Mode.INPUT, w);
            String value = p.name();
            Optional<String> attachFor = attachmentsPurpose(m, p);
            if (attachFor.isPresent()) {
                // Files or uploads already sent: each file is uploaded first, reserved for this scope's thing, then
                // the call names every upload in the caller's order (PROTOCOL.md 16, attachments).
                w.importFrom(CORE, "FileInput");
                w.importFrom(CORE, "UploadId");
                w.importFrom(CORE, async ? "attachment_refs_async" : "attachment_refs");
                String purposeType = typeOf(model.expectShape(upload.get().presigned.param("purpose").orElseThrow().member().getTarget(), StructureShape.class), w);
                String purpose = purposeType + ".model_validate(" + attachFor.get() + ")";
                String send = cls(uploadsNode(), async) + "(self._core, {}).send(f, purpose=" + purpose + ")";
                type = "Sequence[FileInput | UploadId | " + type.replaceFirst("^Sequence\\[(.*)\\]$", "$1") + "]";
                setup.add(p.name() + "_refs = " + (async ? "await attachment_refs_async(" : "attachment_refs(") + p.name() + ", lambda f: " + send
                        + ") if " + p.name() + " is not None else None");
                value = p.name() + "_refs";
            } else if (isReaders(p.member())) {
                w.importFrom(CORE, "ReadersShorthand");
                w.importFrom(CORE, "readers_input");
                type = type + " | ReadersShorthand";
                value = "readers_input(" + p.name() + ")";
            } else if (model.expectShape(p.member().getTarget()).isStructureShape()) {
                // A structure may also be given as a dict of its JSON members: {"guidance": {"instructions": …}}.
                w.importFrom("collections.abc", "Mapping");
                type = type + " | Mapping[str, object]";
            }
            boolean ifMatch = p.binding().getLocation() == HttpBinding.Location.HEADER && p.binding().getLocationName().equalsIgnoreCase("If-Match");
            // If-Match is a required keyword on every operation except the model's @ifMatchOptional ones (PROTOCOL.md 4),
            // whether or not the model marks the header member @required.
            boolean required = (ifMatch ? !m.ifMatchOptional : p.member().isRequired()) && top.filter(member::equals).isEmpty();
            if (top.filter(member::equals).isPresent()) {
                optional.add(p.name() + ": str | None = None");
            } else if (positional.filter(member::equals).isPresent()) {
                params.add(p.name() + ": " + type);
            } else if (required) {
                keyword.add(p.name() + ": " + type);
            } else {
                optional.add(p.name() + ": " + type + " | None = None");
            }
            values.put(member, value);
            String d = CaitlynPythonCodegen.memberDocs(p.member(), false);
            if (!d.isEmpty()) {
                docArgs.add("    " + p.name() + ": " + d.replace("\n", "\n        "));
            }
        }
        if (!keyword.isEmpty() || !optional.isEmpty()) {
            params.add("*");
            params.addAll(keyword);
            params.addAll(optional);
        }
        top.ifPresent(t -> {
            String up = o.param(t).orElseThrow().name();
            setup.add("if (file is None) == (" + up + " is None):");
            setup.add("    raise TypeError(" + Names.pyString("pass a file or " + up + ", not both") + ")");
            setup.add("if file is not None:");
            setup.add("    " + up + " = " + sendFile(async, "file", "") + ".id");
        });
        nestedUpload(o).ifPresent(path -> setup.addAll(nestedUploadSetup(o, path, async, w)));
        describeFile.ifPresent(member -> {
            Shape target = model.expectShape(o.param(member).orElseThrow().member().getTarget());
            String described = (async ? "await " : "") + "self._core.describe_file(file)";
            values.put(member, target.isListShape() ? "[" + described + "]" : described);
        });
        String dict = "{" + o.params.stream().map(p -> Names.pyString(p.name()) + ": "
                + values.getOrDefault(p.member().getMemberName(), "None")).collect(Collectors.joining(", ")) + "}";
        return new Call(params, setup, dict, docArgs);
    }

    private String methodDocs(OperationInfo o, Call c) {
        StringBuilder doc = new StringBuilder(CaitlynPythonCodegen.docs(o.op).orElse(o.name + "."));
        List<String> meta = new ArrayList<>();
        o.since.ifPresent(v -> meta.add("Added in Caitlyn " + v + "."));
        if (!o.stability.equals("ga")) {
            meta.add("Stability: " + o.stability + ".");
        }
        meta.add("`" + o.http.getMethod() + " " + o.http.getUri() + "` (" + o.name + ").");
        doc.append("\n\n").append(String.join(" ", meta));
        if (!c.docArgs.isEmpty()) {
            doc.append("\n\nArgs:\n").append(String.join("\n", c.docArgs));
        }
        List<String> raises = new ArrayList<>();
        for (Shape e : OperationIndex.of(model).getErrors(o.op)) {
            raises.add("    " + symbols.toSymbol(e).getName() + ": HTTP " + e.getTrait(HttpErrorTrait.class).map(t -> String.valueOf(t.getCode())).orElse("error") + ".");
        }
        raises.add("    CaitlynError: any other error response, after retries. A status the operation does not list, but the API"
                + " models elsewhere, raises that status's class (NotFoundError for 404).");
        doc.append("\n\nRaises:\n").append(String.join("\n", raises));
        return doc.toString();
    }

    /** One method of a node (or {@code __call__} of a job's class): the operation, with what the scope fills. */
    private void writeMethod(PythonWriter w, ScopeTree.Node n, ScopeTree.Method m, boolean async, String pyName) {
        OperationInfo o = info(m);
        Call c = call(m, o, w, async, Optional.empty());
        String aw = async ? "await " : "";
        switch (o.kind) {
            case UNARY -> {
                String result = typeOf(o.output, w);
                Optional<ScopeTree.Node> created = createdScope(m);
                Optional<ScopeTree.Node> thing = m.longRunning.isPresent() && created.isEmpty() ? watchedScope(n) : Optional.empty();
                String returns = result;
                if (created.isPresent()) {
                    returns = createdCls(created.get(), async);
                } else if (thing.isPresent()) {
                    w.importFrom(CORE, async ? "AsyncStarted" : "Started");
                    returns = (async ? "AsyncStarted[" : "Started[") + result + ", " + (isDelete(m) ? "None" : waitType(thing.get(), w)) + "]";
                }
                Optional<String> top = topUpload(o);
                if (top.isPresent()) {
                    // Both forms typed: a file, or an upload already sent (its id), never both or neither.
                    String up = o.param(top.get()).orElseThrow().name();
                    String upOptional = up + ": str | None = None";
                    List<String> withFile = new ArrayList<>(c.params.stream().filter(x -> !x.equals(upOptional))
                            .map(x -> x.equals("file: FileInput | None = None") ? "file: FileInput" : x).toList());
                    List<String> withUpload = new ArrayList<>(c.params.stream().filter(x -> !x.startsWith("file: ") && !x.equals(upOptional)).toList());
                    if (!withUpload.contains("*")) {
                        withUpload.add("*");
                    }
                    withUpload.add(withUpload.indexOf("*") + 1, up + ": str");
                    w.importFrom("typing", "overload");
                    for (List<String> form : List.of(withFile, withUpload)) {
                        w.write("@overload");
                        writeDef(w, async, pyName, form, returns);
                        w.indent().write("...").dedent();
                        w.write("");
                    }
                }
                writeDef(w, async, pyName, c.params, returns);
                w.indent();
                String extra = created.map(s -> "\n\nReturns the new " + Names.snake(s.parent.singular.isEmpty() ? s.name : s.parent.singular).replace('_', ' ')
                        + "'s scope (`" + pyPath(s) + "`), with the response's fields" + (s.watch.isPresent() && m.longRunning.isPresent()
                        ? "; `.wait()` waits for the work the call started." : ".")).orElse("")
                        + thing.map(t -> "\n\nReturns the response with `.wait()`, which waits for the work the call started, and `.watch()`.").orElse("")
                        + (m.ifMatchOptional ? "\n\n`if_match` is optional here: without it, the change applies to the resource as it is." : "")
                        + (c.params.stream().anyMatch(x -> x.startsWith("if_match:")) ? "\n\n`if_match=\"*\"` (any version) is sent only when you pass it yourself: no helper fills it in." : "");
                w.write("$D", methodDocs(o, c) + extra);
                c.setup.forEach(line -> w.write("$L", line));
                if (created.isPresent()) {
                    call(w, "out = " + aw + "self._core.request", List.of("_operations." + o.constant, c.dict, result));
                    ScopeTree.Node s = created.get();
                    String source = m.creates.get().source();
                    MemberShape payload = facts.payloads.get(o.output.getId());
                    if (payload != null && source.startsWith("output:" + payload.getMemberName() + ".")) {
                        // The call returns the thing itself: its identifier is the thing's own.
                        source = "output:" + source.substring(("output:" + payload.getMemberName() + ".").length());
                    }
                    String[] parts = source.split(":", 2);
                    String expr = parts[0].equals("output")
                            ? "out." + java.util.Arrays.stream(parts[1].split("\\.")).map(Names::field).collect(Collectors.joining("."))
                            : Names.member(parts[1]);
                    String id = s.identifiers.get(s.identifiers.size() - 1).name();
                    w.write("return $L(self._core, {**self._ids, $L: $L}, out)", createdCls(s, async), Names.pyString(id), expr);
                } else if (thing.isPresent()) {
                    call(w, "out = " + aw + "self._core.request", List.of("_operations." + o.constant, c.dict, result));
                    w.write("follow = $L(self._core, self._ids)", followFn(thing.get(), async));
                    String job = jobExpr(shapeOf(o.output)).orElse("None");
                    String how = isDelete(m) ? "gone" : "wait";
                    // A call that cancels (@longRunning(cancels: true)): its wait returns the thing when the work it cancelled
                    // ends cancelled (wait.cancel-returns).
                    String cancels = m.longRunning.filter(ScopeTree.LongRunning::cancels).isPresent() ? ", cancelled_ok=True" : "";
                    w.write("return $L(out, lambda timeout, on_progress: follow.$L(job_id=$L, timeout=timeout, on_progress=on_progress$L), follow.watch)",
                            async ? "AsyncStarted" : "Started", how, job, cancels);
                } else {
                    call(w, "return " + aw + "self._core.request", List.of("_operations." + o.constant, c.dict, result));
                }
                w.dedent();
            }
            case PAGINATED -> {
                PaginationInfo p = o.pagination.orElseThrow();
                if (p.getItemsMemberPath().size() != 1 || p.getOutputTokenMemberPath().size() != 1) {
                    throw new CodegenException(o.op.getId() + ": nested pagination paths are not supported yet");
                }
                String page = typeOf(o.output, w);
                MemberShape items = p.getItemsMemberPath().get(0);
                if (!(model.expectShape(items.getTarget()) instanceof ListShape list)) {
                    throw new CodegenException(o.op.getId() + ": paginated items must be a list");
                }
                String item = hints.of(list.getMember(), TypeHints.Mode.MODEL, w);
                String tokenParam = Names.member(p.getInputTokenMember().getMemberName());
                String itemsAttr = Names.field(items.getMemberName()) + (items.isRequired() ? "" : " or []");
                String nextAttr = Names.field(p.getOutputTokenMemberPath().get(0).getMemberName());
                String paginator = async ? "AsyncPaginator" : "Paginator";
                w.importFrom(CORE, paginator);
                writeDef(w, false, pyName, c.params, paginator + "[" + page + ", " + item + "]");
                w.indent();
                w.write("$D", methodDocs(o, c) + "\n\nReturns:\n    A paginator over every item on every page, from `cursor` (`.pages()` for the pages, `.page()` for one page). Nothing is requested until it is used.");
                String dict = c.dict.replace(Names.pyString(tokenParam) + ": " + tokenParam + ", ", "").replace(", " + Names.pyString(tokenParam) + ": " + tokenParam, "");
                w.write("params: dict[str, object] = $L", dict);
                w.write("");
                w.write("$Ldef fetch(token: str | None) -> $L:", async ? "async " : "", page);
                w.indent().write("return $Lself._core.request(_operations.$L, {**params, $L: token}, $L)", aw, o.constant, Names.pyString(tokenParam), page).dedent();
                w.write("");
                w.write("return $L(fetch, lambda page: page.$L, lambda page: page.$L, $L)", paginator, itemsAttr, nextAttr, tokenParam);
                w.dedent();
            }
            case STREAM -> {
                StreamTypes t = streamTypes(o, w);
                String stream = async ? "AsyncEventStream" : "EventStream";
                w.importFrom(CORE, stream);
                // A call that sends something (a message) sends it when called; a watch when it is first read.
                boolean eager = !o.op.hasTrait(ReadonlyTrait.class);
                writeDef(w, async && eager, pyName, c.params, stream + "[" + t.unionName + ", " + t.finalType + "]");
                w.indent();
                w.write("$D", methodDocs(o, c) + "\n\nReturns:\n    The event stream: `with` it, iterate it" + (t.finalMember.isPresent() ? ", then `final_message()`" : "")
                        + ". Unknown event types are skipped; a dropped connection is resumed"
                        + (eager ? ".\n\nThe request is sent when the call is made, whether or not the stream is read." : "."));
                c.setup.forEach(line -> w.write("$L", line));
                w.write("params: dict[str, object] = $L", c.dict);
                List<String> args = new ArrayList<>(List.of("_operations." + o.constant, "params", "_operations." + o.constant + "_EVENTS"));
                resume(o, w).ifPresent(args::add);
                if (eager) {
                    call(w, "stream = self._core.stream", args);
                    w.write("return $Lstream.open()", aw);
                } else {
                    call(w, "return self._core.stream", args);
                }
                w.dedent();
            }
        }
    }

    private static boolean isDelete(ScopeTree.Method m) {
        return m.name.equals("delete");
    }

    /** The job a started call's response names: its Operation's or job's id. */
    private Optional<String> jobExpr(StructureShape output) {
        for (String name : List.of("operation", "job")) {
            Optional<MemberShape> member = output.getMember(name);
            if (member.isPresent() && model.expectShape(member.get().getTarget()).asStructureShape().flatMap(s -> s.getMember("id")).isPresent()) {
                String attr = "out." + Names.field(name);
                return Optional.of(member.get().isRequired() ? attr + ".id" : "(" + attr + ".id if " + attr + " is not None else None)");
            }
        }
        return Optional.empty();
    }

    /** What a scope's wait() returns: the thing as its get returns it, or as the watch's snapshot gives it. */
    private String waitType(ScopeTree.Node scope, PythonWriter w) {
        Optional<ScopeTree.Method> get = method(scope, "get");
        if (get.isPresent()) {
            return typeOf(info(get.get()).output, w);
        }
        return snapshotEntity(scope).map(s -> typeOf(s, w)).orElse("None");
    }

    /** The snapshot member a watch gives the scope's thing in ({@code folder} for a folder's watch). */
    private Optional<StructureShape> snapshotEntity(ScopeTree.Node scope) {
        ScopeTree.LongRunning lr = scope.watch.orElseThrow();
        OperationInfo watch = byId.get(lr.watch());
        UnionShape union = model.expectShape(ShapeId.from(watch.sse.orElseThrow().expectStringMember("events").getValue()), UnionShape.class);
        Optional<MemberShape> snapshot = union.getAllMembers().values().stream()
                .filter(mm -> SseEvents.wireName(mm).equals("snapshot")).findFirst();
        String member = ScopeTree.watchedThing(scope);
        return snapshot.flatMap(sm -> model.expectShape(sm.getTarget(), StructureShape.class).getMember(member))
                .map(mm -> model.expectShape(mm.getTarget(), StructureShape.class));
    }

    private String followFn(ScopeTree.Node scope, boolean async) {
        return "_" + (async ? "async_" : "") + "follow_" + Names.snake(classes.get(scope));
    }

    /**
     * {@code _follow_<scope>(core, ids)}: how a scope follows its thing (PROTOCOL.md 16): the watch with the scope's
     * identifiers and its filter member, the error class of each code, and the thing as {@code get} returns it.
     */
    private void writeFollow(PythonWriter w, ScopeTree.Node n, boolean async) {
        ScopeTree.LongRunning lr = n.watch.orElseThrow();
        OperationInfo watch = byId.get(lr.watch());
        String follow = async ? "AsyncFollow" : "Follow";
        w.importFrom(CORE, follow);
        w.importFrom(CORE, "Watched");
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        String type = waitType(n, w);
        w.write("def $L(core: $L, ids: Mapping[str, Any]) -> $L[$L]:", followFn(n, async), core, follow, type);
        w.indent();
        w.write("$D", "How `" + pyPath(n) + "` follows its thing through " + watch.name + ".");
        List<String> entries = new ArrayList<>();
        for (OperationInfo.Param p : watch.params) {
            String member = p.member().getMemberName();
            if (n.identifiers.stream().anyMatch(i -> i.name().equals(member))) {
                entries.add(Names.pyString(p.name()) + ": ids[" + Names.pyString(member) + "]");
            }
        }
        String key = "None";
        if (lr.filter().isPresent()) {
            String last = n.identifiers.get(n.identifiers.size() - 1).name();
            OperationInfo.Param fp = watch.param(lr.filter().get())
                    .orElseThrow(() -> new CodegenException(watch.name + " has no filter member " + lr.filter().get()));
            entries.add(Names.pyString(fp.name()) + ": ids[" + Names.pyString(last) + "]");
            key = "str(ids[" + Names.pyString(last) + "])";
        }
        // A watch of a thing of its own other than the knowledge base (an unattended run's) names its snapshot member.
        String thing = ScopeTree.watchedThing(n);
        String thingArg = lr.filter().isEmpty() && !thing.equals("knowledgeBase") ? ", thing=" + Names.pyString(thing) : "";
        // A watch that takes Last-Event-ID resumes from the last event (an unattended run's); one without starts afresh.
        thingArg += watch.params.stream().filter(p -> p.binding().getLocation() == HttpBinding.Location.HEADER
                && p.binding().getLocationName().equalsIgnoreCase("Last-Event-ID")).findFirst()
                .map(p -> ", last_event_id=" + Names.pyString(p.name())).orElse("");
        w.write("watched = Watched(_operations.$L, {$L}, _operations.$L_EVENTS, $L, $L$L)", watch.constant, String.join(", ", entries), watch.constant,
                lr.filter().map(Names::pyString).orElse("None"), key, thingArg);
        if (method(n, "get").isPresent()) {
            w.write("return $L(core, watched, _operations.CODE_ERRORS, $L(core, ids).get)", follow, cls(n, async));
        } else if (!type.equals("None")) {
            w.write("return $L(core, watched, _operations.CODE_ERRORS, None, $L.from_wire)", follow, type);
        } else {
            w.write("return $L(core, watched, _operations.CODE_ERRORS)", follow);
        }
        w.dedent();
        w.write("\n");
    }

    /** {@code on_progress}: called with the thing's processing, a document's DocumentProcessing or the running Job. */
    private String progressParam(ScopeTree.Node scope, PythonWriter w) {
        ScopeTree.LongRunning lr = scope.watch.orElseThrow();
        UnionShape union = model.expectShape(ShapeId.from(byId.get(lr.watch()).sse.orElseThrow().expectStringMember("events").getValue()), UnionShape.class);
        String all = CaitlynPythonCodegen.processingType(ctx, w, union).orElse("object");
        String[] parts = all.split(" \\| ");
        String type = lr.filter().filter("document"::equals).isPresent() ? parts[0] : parts.length > 2 ? parts[1] : "object";
        w.importFrom("collections.abc", "Callable");
        return "on_progress: Callable[[" + type + "], object] | None = None";
    }

    /** {@code watch()}, {@code wait()} and, for a batch, {@code planned()} on a scope that can be watched. */
    private void writeWatchAndWait(PythonWriter w, ScopeTree.Node n, boolean async) {
        ScopeTree.LongRunning lr = n.watch.orElseThrow();
        OperationInfo watch = byId.get(lr.watch());
        StreamTypes t = streamTypes(watch, w);
        String stream = async ? "AsyncEventStream" : "EventStream";
        w.importFrom(CORE, stream);
        String type = waitType(n, w);
        if (method(n, "watch").isEmpty()) {
            w.write("");
            w.write("def watch(self) -> $L[$L, None]:", stream, t.unionName);
            w.indent();
            w.write("$D", "Watches it: the first event is a `snapshot` of it as it stands (its running and recently finished jobs, and the\n"
                    + "progress of what is being processed), then one event per change. A dropped connection reconnects with no cursor and\n"
                    + "starts again with a snapshot, so nothing is missed. Works the same after a page reload, from the identifier alone.");
            w.write("return $L(self._core, self._ids).watch()", followFn(n, async));
            w.dedent();
        }
        w.write("");
        writeDef(w, async, "wait", List.of("*", "timeout: float | None = None", progressParam(n, w)), type);
        w.indent();
        if (ai.caitlyn.codegen.model.ProcessingWatch.endsOnStatus(model, n)) {
            w.write("$D", "Waits until the run has ended, and returns it as `get()` does, whatever its status: succeeded, failed,\n"
                    + "cancelled, interrupted or untracked. A run's failure is data on the run (`failure`), never raised. If it is gone,\n"
                    + "raises the 404. `timeout` (seconds, no limit by default) raises `TimeoutError`." + (async ? " Cancelling the task stops the wait." : ""));
        } else
        w.write("$D", "Waits until no job runs on it, and returns it" + (method(n, "get").isPresent() ? " as `get()` does" : "")
                + ". A job that ends with some failures still\nreturns them on it; a job that failed raises its error as the typed error for its code, and one that was\n"
                + "cancelled raises `CANCELLED`. If it is gone, raises the 404. `timeout` (seconds, no limit by default) raises\n`TimeoutError`."
                + " `on_progress` is called with its processing: the snapshot's first, if it is being processed, then each\nprogress event's."
                + (async ? " Cancelling the task stops the wait." : ""));
        w.write("return $L$L(self._core, self._ids).wait(timeout=timeout, on_progress=on_progress)", async ? "await " : "", followFn(n, async));
        w.dedent();
        if (lr.filter().filter("batch"::equals).isPresent()) {
            w.write("");
            writeDef(w, async, "planned", List.of("*", "timeout: float | None = None"), type);
            w.indent();
            w.write("$D", "Waits until the batch is planned, or past it, and returns it; raises its failure when planning failed it.\n"
                    + "`timeout` (seconds, no limit by default) raises `TimeoutError`.");
            w.write("return $L$L(self._core, self._ids).planned(timeout=timeout)", async ? "await " : "", followFn(n, async));
            w.dedent();
        }
    }

    /** The scope a create returns: the new thing's scope, with the response's fields, waiting on the work it started. */
    private void writeCreated(PythonWriter w, ScopeTree.Node scope, ScopeTree.Method m, boolean async) {
        OperationInfo o = info(m);
        String result = typeOf(o.output, w);
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        w.write("class $L($L):", createdCls(scope, async), cls(scope, async));
        w.indent();
        w.write("$D\n", "The scope a `create` returns: `" + pyPath(scope)
                + "`, with the call's result.\n\n`result` is what the call returned (the new thing itself, where the call returns one);\n"
                + "its fields are also readable here, except where the scope has a name of its own.");
        w.write("result: $L", result);
        w.write("");
        w.write("def __init__(self, core: $L, ids: Mapping[str, Any], result: $L) -> None:", core, result);
        w.indent().write("super().__init__(core, ids)").write("self.result = result").dedent();
        java.util.Set<String> names = namesOn(scope);
        names.add("id");
        scope.identifiers.forEach(i -> names.add(pyName(i.name())));
        names.add("result");
        for (MemberShape member : shapeOf(o.output).getAllMembers().values()) {
            if (member.hasTrait(HttpHeaderTrait.class)) {
                continue;
            }
            String attr = Names.field(member.getMemberName());
            if (names.contains(attr)) {
                continue;
            }
            String type = hints.of(member, TypeHints.Mode.MODEL, w) + (member.isRequired() ? "" : " | None");
            w.write("");
            w.write("@property");
            w.write("def $L(self) -> $L:", attr, type);
            w.indent();
            String d = CaitlynPythonCodegen.memberDocs(member, false);
            if (!d.isEmpty()) {
                w.write("$D", d);
            }
            w.write("return self.result.$L", attr);
            w.dedent();
        }
        Optional<String> job = jobExpr(shapeOf(o.output));
        if (scope.watch.isPresent() && m.longRunning.isPresent() && job.isPresent()) {
            String type = waitType(scope, w);
            w.write("");
            writeDef(w, async, "wait", List.of("*", "timeout: float | None = None", progressParam(scope, w)), type);
            w.indent();
            w.write("$D", "Waits for the work the call started, and returns it" + (method(scope, "get").isPresent() ? " as `get()` does" : "")
                    + "; raises the work's error if it failed.\n`timeout` (seconds, no limit by default) raises `TimeoutError`.");
            w.write("out = self.result");
            w.write("return $L$L(self._core, self._ids).wait(job_id=$L, timeout=timeout, on_progress=on_progress)", async ? "await " : "",
                    followFn(scope, async), job.get());
            w.dedent();
        }
        w.dedent();
        w.write("\n");
    }

    /** A job with its estimate beside it: {@code kb.fields.fill_in(keys)} and {@code kb.fields.fill_in.estimate(keys)}. */
    private void writeJobClass(PythonWriter w, ScopeTree.Node n, ScopeTree.Method m, boolean async) {
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        ScopeTree.Method est = m.estimate.orElseThrow();
        OperationInfo eo = info(est);
        w.write("class $L:", methodCls(n, m.name, async));
        w.indent();
        w.write("$D\n", "`" + pyPath(n) + "." + Names.snake(m.name) + "`: call it to start the job; `.estimate(…)` with the same arguments says what it\nwould do and cost.");
        w.write("def __init__(self, core: $L, ids: Mapping[str, Any]) -> None:", core);
        w.indent().write("self._core = core").write("self._ids: dict[str, Any] = dict(ids)").dedent();
        w.write("");
        writeMethod(w, n, m, async, "__call__");
        w.write("");
        // Where the job takes a file, the estimate takes the same file and sends only its description.
        Optional<String> describe = topUpload(info(m)).flatMap(x -> eo.params.stream().filter(p -> {
            Shape t = model.expectShape(p.member().getTarget());
            Shape inner = t.isListShape() ? model.expectShape(((ListShape) t).getMember().getTarget()) : t;
            return inner.getId().getName().equals("UploadDescription");
        }).findFirst().map(p -> p.member().getMemberName()));
        Call c = call(est, eo, w, async, describe);
        String result = typeOf(eo.output, w);
        writeDef(w, async, "estimate", c.params, result);
        w.indent();
        w.write("$D", methodDocs(eo, c) + "\n\nDoes no work" + (describe.isPresent() ? " and uploads nothing: the file is only described" : "") + ".");
        call(w, "return " + (async ? "await " : "") + "self._core.request", List.of("_operations." + eo.constant, c.dict, result));
        w.dedent();
        w.dedent();
        w.write("\n");
    }

    /** {@code core.uploads.send(file)}: hash the file, reserve the upload, PUT the bytes (PROTOCOL.md 10, 14). */
    private void writeUploadSend(PythonWriter w, ScopeTree.Node n, OperationInfo presigned, boolean async) {
        String result = typeOf(presigned.output, w);
        w.importFrom(CORE, "FileInput");
        List<String> handled = List.of("fileName", "contentType", "byteSize", "sha256");
        List<String> sig = new ArrayList<>(List.of("file: FileInput", "*"));
        List<String> passthrough = new ArrayList<>();
        for (OperationInfo.Param p : presigned.params) {
            if (handled.contains(p.member().getMemberName())) {
                continue;
            }
            if (p.member().isRequired()) {
                throw new CodegenException(presigned.op.getId() + ": the upload helper cannot fill required member " + p.member().getMemberName());
            }
            sig.add(p.name() + ": " + hints.of(p.member(), TypeHints.Mode.INPUT, w) + " | None = None");
            passthrough.add(p.name());
        }
        String reserve = n.methods.stream().filter(m -> m.operation.getId().equals(presigned.op.getId())).findFirst().map(m -> Names.snake(m.name)).orElseThrow();
        writeDef(w, async, "send", sig, result);
        w.indent();
        w.write("$D", "Uploads a file: hashes it (SHA-256), reserves the upload with `" + reserve + "`, then sends the bytes to\n"
                + "its presigned URL with exactly the headers it names, and returns the upload.\n\n"
                + "The PUT carries no Caitlyn credentials and is retried as a call that is safe to repeat. A file over 2 GB fails\n"
                + "with `FILE_TOO_LARGE` before any request, a path that changes after it was hashed with `FILE_CHANGED`, and a PUT\n"
                + "that still fails after retries with `UPLOAD_PUT_FAILED`.\n\n"
                + "Args:\n    file: an `UploadFile` (`from_path`, `from_bytes`, `from_stream`), or a path.");
        w.write("with $Lself._core.prepare_file(file) as f:", async ? "await " : "");
        w.indent();
        List<String> args = new ArrayList<>(List.of("file_name=f.name", "content_type=f.content_type", "byte_size=f.byte_size", "sha256=f.sha256"));
        passthrough.forEach(p -> args.add(p + "=" + p));
        call(w, "upload = " + (async ? "await " : "") + "self." + reserve, args);
        w.write("$Lself._core.put_file(upload.upload_method, upload.upload_url, upload.required_headers, f)", async ? "await " : "");
        w.dedent();
        w.write("return upload");
        w.dedent();
    }

    /** The node that holds the presigned upload: core.uploads. */
    private ScopeTree.Node uploadsNode() {
        for (ScopeTree.Node n : tree.root.walk()) {
            if (n.methods.stream().anyMatch(m -> m.operation.getId().equals(upload.get().presigned.op.getId()))) {
                return n;
            }
        }
        throw new CodegenException("The presigned upload has no place in the client");
    }

    /** The expression that uploads {@code file} with core.uploads.send and gives the upload. */
    private String sendFile(boolean async, String file, String purpose) {
        String call = cls(uploadsNode(), async) + "(self._core, {}).send(" + file + (purpose.isEmpty() ? "" : ", purpose=" + purpose) + ")";
        return async ? "(await " + call + ")" : call;
    }

    /**
     * A nested upload target ({@code avatar.mark.pictureUploadId}): a file at that path is uploaded, with the purpose the
     * member's documentation names, and replaced by the upload's id before the call (PROTOCOL.md 10).
     */
    private List<String> nestedUploadSetup(OperationInfo o, String path, boolean async, PythonWriter w) {
        String[] parts = path.split("\\.");
        OperationInfo.Param root = o.param(parts[0]).orElseThrow(() -> new CodegenException(o.op.getId() + ": @uploadTarget " + path + ": no member " + parts[0]));
        StructureShape at = model.expectShape(root.member().getTarget(), StructureShape.class);
        MemberShape leaf = null;
        List<String> inner = new ArrayList<>();
        for (int i = 1; i < parts.length; i++) {
            leaf = at.getMember(parts[i]).orElseThrow();
            inner.add(Names.pyString(Names.field(parts[i])));
            if (i < parts.length - 1) {
                at = model.expectShape(leaf.getTarget(), StructureShape.class);
            }
        }
        String purpose = "";
        java.util.regex.Matcher pm = java.util.regex.Pattern.compile("purpose: \\{(\\w+): (true|false)\\}")
                .matcher(CaitlynPythonCodegen.docs(leaf).orElse(""));
        if (pm.find()) {
            OperationInfo.Param purposeParam = upload.get().presigned.param("purpose")
                    .orElseThrow(() -> new CodegenException(o.op.getId() + ": " + path + " names a purpose, but the presigned upload takes none"));
            String type = typeOf(model.expectShape(purposeParam.member().getTarget(), StructureShape.class), w);
            purpose = type + ".model_validate({" + Names.pyString(pm.group(1)) + ": " + (pm.group(2).equals("true") ? "True" : "False") + "})";
        }
        w.importFrom(CORE, "file_at");
        w.importFrom(CORE, "with_upload_id");
        String tuple = "(" + String.join(", ", inner) + (inner.size() == 1 ? "," : "") + ")";
        String var = Names.field(parts[parts.length - 1]).replaceFirst("_upload_id$", "").replaceFirst("_id$", "") + "_file";
        List<String> out = new ArrayList<>();
        out.add(var + " = file_at(" + root.name() + ", " + tuple + ")");
        out.add("if " + var + " is not None:");
        out.add("    upload = " + sendFile(async, var, purpose));
        out.add("    " + root.name() + " = with_upload_id(" + root.name() + ", " + tuple + ", upload.id)");
        return out;
    }

    /** {@code kb.ingestion.sync(source, …)} and {@code .estimate(source, …)}: the runtime's helper (PROTOCOL.md 15). */
    private void writeSyncClass(PythonWriter w, ScopeTree.Node n, boolean async) {
        Map<String, OperationInfo> found = syncOps().orElseThrow();
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        String batch = typeOf(found.get("GetIngestionBatch").output, w);
        String item = syncItemType(found, w);
        String estimate = typeOf(found.get("EstimateIngestion").output, w);
        String policy = hints.of(found.get("CreateIngestionBatch").param("policy").orElseThrow().member(), TypeHints.Mode.INPUT, w);
        for (String s : List.of("SyncFile", "SyncPlan", "IngestionProgress", "SyncReport", "sync_async", "sync_estimate_async",
                async ? "AsyncHelperCore" : "SyncHelperCore")) {
            w.importFrom(CORE, s);
        }
        if (!async) {
            w.importFrom(CORE, "run_sync");
        }
        w.importFrom("collections.abc", "Awaitable");
        w.importFrom("collections.abc", "Callable");
        w.importFrom("collections.abc", "Mapping");
        w.importFrom("collections.abc", "Sequence");
        w.importFrom("os", "PathLike");
        String plan = "SyncPlan[" + batch + ", " + item + ", " + estimate + "]";
        String maybe = async ? " | Awaitable[%s]" : "";
        List<String> common = List.of(
                "source: str | PathLike[str] | Sequence[SyncFile]",
                "*",
                "folder: str = \"/\"",
                "policy: " + policy + " | None = None",
                "include: Sequence[str] = ()",
                "exclude: Sequence[str] = ()",
                "key: Callable[[SyncFile], str | None] | None = None",
                "source_url: Callable[[SyncFile], str | None] | None = None",
                "metadata: Callable[[SyncFile], Mapping[str, object] | None] | None = None",
                "remove_missing: bool = False",
                "upload_window_seconds: int | None = None");
        List<String> sig = new ArrayList<>(common);
        sig.addAll(List.of(
                "confirm: Callable[[" + plan + "], bool" + maybe.formatted("bool") + "] | None = None",
                "resolver: Callable[[list[" + item + "]], Mapping[str, str]" + maybe.formatted("Mapping[str, str]") + "] | None = None",
                "on_progress: Callable[[IngestionProgress[" + item + "]], object] | None = None",
                "on_item: Callable[[" + item + "], object] | None = None",
                "concurrency: int = 6",
                "cancel_ingestion: bool = False"));
        w.write("class $L:", methodCls(n, "sync", async));
        w.indent();
        w.write("$D\n", "`" + pyPath(n) + ".sync`: keep the knowledge base in step with a folder of files, or a list of files; `.estimate(…)` with\n"
                + "the same arguments plans it and says what it would cost, uploading nothing.");
        w.write("def __init__(self, core: $L, ids: Mapping[str, Any]) -> None:", core);
        w.indent().write("self._core = core").write("self._ids: dict[str, Any] = dict(ids)").dedent();
        w.write("");
        writeDef(w, async, "__call__", sig, "SyncReport[" + batch + ", " + item + "]");
        w.indent();
        w.write("$D", "Keeps the knowledge base in step with a folder of files, or a list of files, through one ingestion batch.\n\n"
                + "In order: hashes each file; creates the batch to start by hand (10,000 items a call); waits until it is planned and\n"
                + "prices it; resolves it; starts it; uploads each file that needs its bytes under the batch's upload policy, at most\n"
                + "`concurrency` at once, and reports them; waits until the batch finishes; and returns a report of every item.\n\n"
                + "Args:\n"
                + "    source: a folder (walked without following symbolic links, filtered by `include`, `exclude` and each\n"
                + "        folder's `.caitlynignore`), or a list of `SyncFile`.\n"
                + "    folder: the knowledge base folder the files' relative paths are under (default `/`).\n"
                + "    policy: the rules that resolve each item's outcome (`IngestionPolicy`).\n"
                + "    key: a function of each file giving its item's `externalId`; by default its relative path.\n"
                + "    source_url, metadata: functions of each file giving its item's `sourceUrl` and `metadata`.\n"
                + "    remove_missing: also remove each document under `folder` that no file names.\n"
                + "    upload_window_seconds: how long the batch waits for its files once it starts, in seconds: each upload policy\n"
                + "        lasts this long. The server's default (30 minutes) when not given.\n"
                + "    confirm: called with the plan and its estimate before anything is uploaded; returning False cancels the batch\n"
                + "        and raises CaitlynError with code CANCELLED (status 0) and the report so far as its report.\n"
                + "    resolver: called with the items the policy left `unresolved`; returns a resolution (`add`,\n"
                + "        `new_version`, `overwrite`, `skip`…) for each item id. Without one, unresolved items raise\n"
                + "        `INGESTION_BATCH_UNRESOLVED` and the batch is left planned.\n"
                + "    on_progress: called with each `IngestionProgress` (`checksum`, `planning`, `planned`, `upload` in bytes,\n"
                + "        `queued`, `processing`, then the batch's final status).\n"
                + "    on_item: called with each item once it is final.\n"
                + "    concurrency: uploads at once (default 6).\n"
                + "    cancel_ingestion: when the call is cancelled, also cancel the batch, stopping ingestion already running.\n\n"
                + "An item whose upload fails is reported failed (`UPLOAD_FAILED`) and never raised; an error that stops the whole batch\n"
                + "is raised with the batch's own failure code.\n\n"
                + (async ? "Cancelling the task stops new uploads, aborts those in flight and raises `SyncCancelledError`, an\n"
                         + "`asyncio.CancelledError` whose `report` is the report so far."
                         : "Cancellation is KeyboardInterrupt (Ctrl-C): it drops the uploads in flight, starts no new ones, and raises\n"
                         + "`SyncInterrupted`, a `KeyboardInterrupt` whose `report` is the report so far."));
        String coreExpr = (async ? "AsyncHelperCore" : "SyncHelperCore") + "(self._core), _operations.SYNC_API, " + batch + ", " + item + ", " + estimate;
        List<String> args = new ArrayList<>(List.of(coreExpr, "self._ids[\"knowledgeBaseId\"]", "source", "folder=folder", "policy=policy",
                "include=include", "exclude=exclude", "key=key", "source_url=source_url", "metadata=metadata", "remove_missing=remove_missing",
                "upload_window_seconds=upload_window_seconds"));
        args.addAll(List.of("confirm=confirm", "resolver=resolver", "on_progress=on_progress", "on_item=on_item", "concurrency=concurrency",
                "cancel_ingestion=cancel_ingestion"));
        writeRunner(w, async, "sync_async", args);
        w.dedent();
        w.write("");
        writeDef(w, async, "estimate", common, plan);
        w.indent();
        w.write("$D", "What `sync` with the same arguments would do and cost: steps 1 to 3 (hash, create the batch, wait until it is planned)\n"
                + "and the price of the items that need bytes. Uploads nothing; the batch is left planned: its plan goes stale after 5 minutes (starting it plans it again), and a batch never started is cleared after 7 days.");
        List<String> eargs = new ArrayList<>(List.of(coreExpr, "self._ids[\"knowledgeBaseId\"]", "source", "folder=folder", "policy=policy",
                "include=include", "exclude=exclude", "key=key", "source_url=source_url", "metadata=metadata", "remove_missing=remove_missing",
                "upload_window_seconds=upload_window_seconds"));
        writeRunner(w, async, "sync_estimate_async", eargs);
        w.dedent();
        w.dedent();
        w.write("\n");
    }

    /**
     * {@code batch.upload(files)} and {@code batch.upload.estimate(files)} (PROTOCOL.md 15): sync's upload and pricing steps
     * for a batch built by hand, from the runtime's {@code batch_upload_async} and {@code batch_upload_estimate_async}.
     */
    private void writeUploadClass(PythonWriter w, ScopeTree.Node n, boolean async) {
        Map<String, OperationInfo> found = syncOps().orElseThrow();
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        String batch = typeOf(found.get("GetIngestionBatch").output, w);
        String item = syncItemType(found, w);
        String estimate = typeOf(found.get("EstimateIngestion").output, w);
        String started = async ? "AsyncStarted" : "Started";
        for (String s : List.of("BatchFiles", "BatchUpload", "IngestionProgress", "batch_upload_async", "batch_upload_estimate_async", started,
                async ? "AsyncHelperCore" : "SyncHelperCore")) {
            w.importFrom(CORE, s);
        }
        if (!async) {
            w.importFrom(CORE, "run_sync");
        }
        w.importFrom("collections.abc", "Callable");
        w.importFrom("collections.abc", "Mapping");
        String path = pyPath(n);
        w.write("class $L:", methodCls(n, "upload", async));
        w.indent();
        w.write("$D\n", "`" + path + ".upload(files)`: sends the files of the batch's items awaiting upload; `.estimate(files)` says what\n"
                + "uploading them would take and cost, before the batch is started.");
        w.write("def __init__(self, core: $L, ids: Mapping[str, Any]) -> None:", core);
        w.indent().write("self._core = core").write("self._ids: dict[str, Any] = dict(ids)").dedent();
        w.write("");
        String coreExpr = (async ? "AsyncHelperCore" : "SyncHelperCore") + "(self._core), _operations.SYNC_API, " + batch + ", " + item;
        String idArgs = "self._ids[\"knowledgeBaseId\"], self._ids[\"ingestionBatchId\"]";
        writeDef(w, async, "__call__", List.of("files: BatchFiles[" + item + "]", "*", "concurrency: int = 6",
                "on_progress: Callable[[IngestionProgress[" + item + "]], object] | None = None",
                "on_item: Callable[[" + item + "], object] | None = None"),
                started + "[BatchUpload[" + batch + ", " + item + "], " + batch + "]");
        w.indent();
        w.write("$D", "Sends the files of the batch's items awaiting upload, as `ingestion.sync` does, and reports them.\n\n"
                + "Start the batch first (`batch.start()`); a batch created with `start=\"when_planned\"` that is still planning is\n"
                + "followed until it runs. Otherwise a batch not started raises `INGESTION_BATCH_NOT_STARTED` (status 0), with nothing sent.\n\n"
                + "Args:\n"
                + "    files: each item's file, by the item's path as the batch stores it (`/hr/leave.pdf`; a key without its\n"
                + "        leading `/` matches too), or a function from an item to its file (or None for none).\n"
                + "    concurrency: uploads at once (default 6).\n"
                + "    on_progress: called with each `IngestionProgress`: `upload` in bytes, with the item, then `queued`, items\n"
                + "        accepted of items uploaded.\n"
                + "    on_item: called with each item that fails during this call (`UPLOAD_FAILED`, `FILE_CHANGED`, or a second\n"
                + "        `CHECKSUM_MISMATCH`). Accepted items end later, during ingestion: `wait()` and `watch()` report them.\n\n"
                + "Files are not hashed: a file whose size is not its item's fails that item with `FILE_CHANGED` before it is\n"
                + "sent, and storage refuses other bytes of the right size against the item's checksum (`FILE_CHANGED` too). One\n"
                + "item's failure is that item's alone. An awaiting item with no file given is left awaiting upload, in `not_given`;\n"
                + "a given path that matches no awaiting item is in `unmatched`.\n\n"
                + "Returns the `BatchUpload` (`batch`, `items`, `not_given`, `unmatched`) as `.result`, with `.wait()`, which\n"
                + "returns the batch once it has finished, and `.watch()`.\n\n"
                + (async ? "Cancelling the task aborts the uploads in flight and raises `asyncio.CancelledError`; the batch is left as it is\n"
                         + "(`batch.cancel()` cancels it)."
                         : "Cancellation is KeyboardInterrupt (Ctrl-C): it drops the uploads in flight, starts no new ones, and is raised\n"
                         + "again; the batch is left as it is (`batch.cancel()` cancels it)."));
        List<String> args = List.of(coreExpr, idArgs, "files", "concurrency=concurrency", "on_progress=on_progress", "on_item=on_item");
        w.write(async ? "out = await batch_upload_async(" : "out = run_sync(lambda: batch_upload_async(");
        w.indent();
        for (String a : args) {
            w.write("$L,", a);
        }
        w.dedent();
        w.write(async ? ")" : "))");
        w.write("follow = $L(self._core, self._ids)", followFn(n, async));
        w.write("return $L(out, lambda timeout, on_progress: follow.wait(timeout=timeout, on_progress=on_progress), follow.watch)", started);
        w.dedent();
        w.write("");
        writeDef(w, async, "estimate", List.of("files: BatchFiles[" + item + "] | None = None", "*", "timeout: float | None = None"), estimate);
        w.indent();
        w.write("$D", "What uploading the batch's items that need bytes (`add`, `new_version`, `overwrite`) would take and cost.\n\n"
                + "A batch still planning is waited on first (`timeout` in seconds, as `planned()` takes it); a draft batch raises\n"
                + "`INGESTION_BATCH_NOT_PLANNED` (status 0), with nothing sent. Each item is priced from its file when `files` gives\n"
                + "one (its name, content type and size, and the `hints` given with it: the file is neither hashed nor read), else\n"
                + "from the item itself. With nothing to price, the estimate is empty and nothing is sent.");
        writeRunner(w, async, "batch_upload_estimate_async", List.of(coreExpr.replace(", " + item, ", " + item + ", " + estimate), idArgs, "files", "timeout=timeout"));
        w.dedent();
        w.dedent();
        w.write("\n");
    }

    private void writeRunner(PythonWriter w, boolean async, String fn, List<String> args) {
        w.write(async ? "return await $L(" : "return run_sync(lambda: $L(", fn);
        w.indent();
        for (String a : args) {
            w.write("$L,", a);
        }
        w.dedent();
        w.write(async ? ")" : "))");
    }

    private Optional<String> resume(OperationInfo o, PythonWriter w) {
        Optional<String> with = o.sse.flatMap(s -> s.getStringMember("resumeWith")).map(s -> s.getValue());
        if (with.isEmpty()) {
            return Optional.empty();
        }
        OperationInfo r = byId.get(ShapeId.from(with.get()));
        if (r == null) {
            throw new CodegenException(o.op.getId() + ": resumeWith " + with.get() + " is not a generated operation");
        }
        String lastId = null;
        List<String> carried = new ArrayList<>();
        for (OperationInfo.Param p : r.params) {
            if (p.binding().getLocation() == HttpBinding.Location.HEADER && p.binding().getLocationName().equalsIgnoreCase("Last-Event-ID")) {
                lastId = p.name();
            } else if (o.param(p.member().getMemberName()).isPresent()) {
                carried.add(Names.pyString(p.name()) + ": params[" + Names.pyString(o.param(p.member().getMemberName()).get().name()) + "]");
            } else if (p.member().isRequired()) {
                throw new CodegenException(r.op.getId() + " resumes " + o.op.getId() + " but needs " + p.member().getMemberName() + ", which " + o.name + " does not take");
            }
        }
        w.importFrom(CORE, "Resume");
        // Without a Last-Event-ID member the watch reconnects with no cursor, and starts again with a snapshot (PROTOCOL.md 16).
        return Optional.of("Resume(_operations." + r.constant + ", {" + String.join(", ", carried) + "}" + (lastId == null ? "" : ", " + Names.pyString(lastId)) + ")");
    }

    /** {@code prefix(a, b, c)}, one argument per line when it would not fit in 120 columns. */
    private static void call(PythonWriter w, String prefix, List<String> args) {
        String one = prefix + "(" + String.join(", ", args) + ")";
        if (one.length() + 8 <= 120) {
            w.write("$L", one);
            return;
        }
        w.write("$L(", prefix);
        w.indent();
        for (String a : args) {
            w.write("$L,", a);
        }
        w.dedent();
        w.write(")");
    }

    private void writeDef(PythonWriter w, boolean async, String name, List<String> params, String returns) {
        List<String> all = new ArrayList<>();
        all.add("self");
        all.addAll(params);
        if (all.get(all.size() - 1).equals("*")) {
            all.remove(all.size() - 1);
        }
        String prefix = (async ? "async " : "") + "def " + name + "(";
        String oneLine = prefix + String.join(", ", all) + ") -> " + returns + ":";
        if (oneLine.length() + 8 <= 120) {
            w.write("$L", oneLine);
            return;
        }
        w.write("$L", prefix);
        w.indent();
        for (String p : all) {
            w.write("$L,", p);
        }
        w.dedent();
        w.write(") -> $L:", returns);
    }

    /** The structure a call's result is read as: the thing, for an output that returns one (ResultNames.payloadOf). */
    private StructureShape shapeOf(StructureShape output) {
        MemberShape payload = facts.payloads.get(output.getId());
        return payload == null ? output : model.expectShape(payload.getTarget(), StructureShape.class);
    }

    private String typeOf(StructureShape output, PythonWriter w) {
        Symbol s = symbols.toSymbol(shapeOf(output));
        w.importFrom(s.getNamespace(), s.getName());
        return s.getName();
    }

    private Optional<OperationInfo> byName(String name) {
        return ops.stream().filter(o -> o.name.equals(name)).findFirst();
    }


    private void writeClientClass(PythonWriter w, boolean async) {
        ScopeTree.Node root = tree.root;
        String name = async ? "AsyncCaitlyn" : "Caitlyn";
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        w.importFrom(CORE, core);
        w.importFrom(CORE, "ClientConfig");
        w.importFrom(CORE, "Interceptor");
        w.importFrom(CORE, "Auth");
        w.importFrom(CORE, async ? "AsyncAuthSession" : "SyncAuthSession");
        w.importFrom(CORE, "RetryPolicy");
        w.importFrom("collections.abc", "Sequence");
        w.importFrom("typing", "Self");
        w.importFrom("opentelemetry.trace", "TracerProvider");
        w.importFrom(module("_version"), "SDK_MODEL");
        w.importFrom(module("_version"), "__version__");
        w.write("class $L:", name);
        w.indent();
        String doc = CaitlynPythonCodegen.docs(service).orElse(title) + "\n\n"
                + (async ? "Asynchronous client. Use as `async with AsyncCaitlyn(...) as caitlyn:`, or call `aclose()`."
                         : "Synchronous client. Use as `with Caitlyn(...) as caitlyn:`, or call `close()`.")
                + "\n\nArgs:\n"
                + "    workspace: your workspace host, for example `your-company.getcaitlyn.ai`.\n"
                + "    auth: how to sign in (`caitlyn.auth`), for example `Token(os.environ[\"CAITLYN_TOKEN\"])` or\n"
                + "        `ClientCredentials(client_id, client_secret)`.\n"
                + "    endpoint: overrides the URL built from `workspace` (a proxy, a local app). Tokens are still for `workspace`.\n"
                + "    max_attempts: attempts per call, including the first (default 3).\n"
                + "    max_retry_delay: the longest Retry-After to wait for, in seconds (default 60); above it the call fails at once.\n"
                + "    retry_budget: the retry tokens this client's calls share (default 500; a retry costs 5, or 10 after no response;\n"
                + "        a success gives back 1, or its last retry's cost). When it is spent, calls fail without retrying. 0 turns retries off.\n"
                + "    retry: the full retry policy.\n"
                + "    timeout: how long an API call waits to connect, and for each read and write, in seconds or as an `httpx.Timeout`\n"
                + "        (default 120). A call whose response has not started by then fails and is retried; streams stay open while\n"
                + "        their keep-alives arrive. `None` waits as long as it takes.\n"
                + "    storage_stall_timeout: how long a send to storage (an upload's bytes) may send and receive nothing, in seconds,\n"
                + "        before that attempt is abandoned and retried (default 60). Not a limit on the whole upload. `None` never gives up.\n"
                + "    tracer_provider: OpenTelemetry tracer provider (default: the global one).\n"
                + "    interceptors: hooks run around every call and attempt.\n"
                + "    app_id: your application's name, sent in the user agent as `app/<app_id>`.\n"
                + "    ci: the CI system your application recognises it runs in, sent after it as `ci/<ci>` (github, gitlab, buildkite,\n"
                + "        circleci, jenkins, azure-pipelines, bitbucket, or generic). 1 to 32 of a-z, 0-9 and -.\n"
                + "    agent: the AI agent your application recognises is driving it, sent last as `agent/<agent>` (for example\n"
                + "        claude-code). 1 to 32 of a-z, 0-9 and -.\n"
                + "    http_client: your own httpx client, for its transport, proxy or TLS settings. Requests go to the workspace or `endpoint`; its `base_url` is not used."
                + (async ? "" : "\n        With your own httpx.Client, Ctrl-C stops an upload still sending at once, but one that has finished sending waits for\n"
                        + "        storage's answer, up to `storage_stall_timeout`.");
        w.write("$D\n", doc);
        w.write("auth: $L", async ? "AsyncAuthSession" : "SyncAuthSession");
        w.write("$D", "The client's sign-in: the `OAuth` mode's `authorization_url`, `handle_callback` and `sign_out`, and the current token.");
        for (Map.Entry<String, ScopeTree.Node> c : root.children.entrySet()) {
            w.write("$L: $L", Names.snake(c.getKey()), cls(c.getValue(), async));
        }
        w.write("");
        w.write("def __init__(");
        w.indent();
        w.write("self,");
        w.write("*,");
        w.write("workspace: str | None = None,");
        w.write("auth: Auth | httpx.Auth | None = None,");
        w.write("endpoint: str | None = None,");
        w.write("max_attempts: int | None = None,");
        w.write("max_retry_delay: float | None = None,");
        w.write("retry_budget: int | None = None,");
        w.write("retry: RetryPolicy | None = None,");
        w.write("timeout: float | httpx.Timeout = 120.0,");
        w.write("storage_stall_timeout: float | None = 60.0,");
        w.write("tracer_provider: TracerProvider | None = None,");
        w.write("interceptors: Sequence[Interceptor] = (),");
        w.write("app_id: str | None = None,");
        w.write("ci: str | None = None,");
        w.write("agent: str | None = None,");
        w.write("http_client: $L | None = None,", async ? "httpx.AsyncClient" : "httpx.Client");
        w.dedent();
        w.write(") -> None:");
        w.indent();
        w.write("config = ClientConfig.create(");
        w.indent();
        w.write("workspace=workspace,");
        w.write("endpoint=endpoint,");
        w.write("auth=auth,");
        w.write("sdk_version=__version__,");
        w.write("sdk_model=SDK_MODEL,");
        w.write("max_attempts=max_attempts,");
        w.write("max_retry_delay=max_retry_delay,");
        w.write("retry_budget=retry_budget,");
        w.write("retry=retry,");
        w.write("timeout=timeout,");
        w.write("storage_stall_timeout=storage_stall_timeout,");
        w.write("tracer_provider=tracer_provider,");
        w.write("interceptors=interceptors,");
        w.write("app_id=app_id,");
        w.write("ci=ci,");
        w.write("agent=agent,");
        w.dedent();
        w.write(")");
        w.write("self._core = $L(config, http_client)", core);
        w.write("self.auth = self._core.auth");
        w.write("self._ids: dict[str, Any] = {}");
        for (Map.Entry<String, ScopeTree.Node> c : root.children.entrySet()) {
            w.write("self.$L = $L(self._core, {})", Names.snake(c.getKey()), cls(c.getValue(), async));
        }
        w.dedent();
        for (ScopeTree.Method m : root.methods) {
            w.write("");
            writeMethod(w, root, m, async, Names.snake(m.name));
        }
        w.write("");
        w.write("@property");
        w.write("def server_api_version(self) -> str | None:");
        w.indent().write("$D", "The Caitlyn-Api-Version the server last reported; None before the first response.")
                .write("return self._core.server_api_version").dedent();
        w.write("");
        if (async) {
            w.write("async def aclose(self) -> None:");
            w.indent().write("$D", "Close the connections this client opened.").write("await self._core.aclose()").dedent();
            w.write("");
            w.write("async def __aenter__(self) -> Self:");
            w.indent().write("return self").dedent();
            w.write("");
            w.write("async def __aexit__(self, *exc: object) -> None:");
            w.indent().write("await self.aclose()").dedent();
        } else {
            w.write("def close(self) -> None:");
            w.indent().write("$D", "Close the connections this client opened.").write("self._core.close()").dedent();
            w.write("");
            w.write("def __enter__(self) -> Self:");
            w.indent().write("return self").dedent();
            w.write("");
            w.write("def __exit__(self, *exc: object) -> None:");
            w.indent().write("self.close()").dedent();
        }
        w.dedent();
        w.write("\n");
    }

    // ------------------------------------------------------------------ package files

    private void writeVersion() {
        ctx.writerDelegator().useFileWriter(settings.file("_version"), module("_version"), w -> {
            w.write("$D\n", "SDK and API versions, and the `@since` and `@stability` metadata from the model.");
            w.importFrom("typing", "Final");
            w.write("__version__: Final = $L", Names.pyString(settings.version()));
            w.write("SDK_MODEL: Final = $L", Names.pyString(facts.apiVersion));
            w.write("$D\n", "The model version this SDK was generated from (the newest `@since`), sent as Caitlyn-Sdk-Model.");
            w.write("SINCE: Final[dict[str, str]] = {");
            w.indent();
            for (OperationInfo o : ops) {
                o.since.ifPresent(v -> w.write("$L: $L,", Names.pyString(o.name), Names.pyString(v)));
                for (OperationInfo.Param p : o.params) {
                    CaitlynTraits.since(p.member()).ifPresent(v -> w.write("$L: $L,", Names.pyString(o.name + "." + p.member().getMemberName()), Names.pyString(v)));
                }
            }
            w.dedent();
            w.write("}");
            w.write("$D\n", "The release that introduced each operation (and each newer input member, as `Operation.member`).");
            w.write("STABILITY: Final[dict[str, str]] = {");
            w.indent();
            for (OperationInfo o : ops) {
                w.write("$L: $L,", Names.pyString(o.name), Names.pyString(o.stability));
            }
            w.dedent();
            w.write("}");
        });
    }

    private void writeAuth() {
        ctx.writerDelegator().useFileWriter(settings.file("auth"), module("auth"), w -> {
            w.write("$D\n", "Sign-in modes (model/PROTOCOL.md section 12): `Token`, `ClientCredentials`, `OAuth`, `AwsIam`, "
                    + "`WorkloadIdentity` and `Session`.");
            List<String> names = List.of("AsyncAuthSession", "Auth", "AuthorizationRequest", "AwsCredentials", "AwsIam", "CaitlynAuthError",
                    "ClientCredentials", "LockingTokenStore", "OAuth", "OAuthTokens", "Session", "SyncAuthSession", "Token", "TokenStore", "WorkloadIdentity");
            for (String n : names) {
                w.importFrom(CORE + ".auth", n);
            }
            w.write("__all__ = [$L]", String.join(", ", names.stream().map(n -> "\"" + n + "\"").toList()));
        });
    }

    private void writeInit() {
        List<String> names = new ArrayList<>();
        ctx.writerDelegator().useFileWriter(settings.packageName() + "/__init__.py", settings.packageName(), w -> {
            w.write("$D\n", "The " + title + " Python SDK.\n\n"
                    + "```python\nfrom caitlyn import Caitlyn\nfrom caitlyn.auth import Token\n\n"
                    + "caitlyn = Caitlyn(workspace=\"your-company.getcaitlyn.ai\", auth=Token(os.environ[\"CAITLYN_TOKEN\"]))\n```");
            for (String n : List.of("AsyncCaitlyn", "Caitlyn")) {
                w.importFrom(module("_client"), n);
                names.add(n);
            }
            // The scopes' classes, for type annotations (kb: KnowledgeBaseScope), in both clients.
            for (boolean async : new boolean[] {false, true}) {
                for (Map.Entry<ScopeTree.Node, String> e : classes.entrySet()) {
                    String n = cls(e.getKey(), async);
                    w.importFrom(module("_client"), n);
                    names.add(n);
                    if (createdScopes.containsKey(e.getKey())) {
                        w.importFrom(module("_client"), createdCls(e.getKey(), async));
                        names.add(createdCls(e.getKey(), async));
                    }
                }
                for (String key : methodClasses.keySet()) {
                    String n = (async ? "Async" : "") + methodClasses.get(key);
                    w.importFrom(module("_client"), n);
                    names.add(n);
                }
            }
            if (model.shapes().anyMatch(sh -> sh.hasTrait(CaitlynTraits.ERROR_CODES))) {
                Symbol err = symbols.toSymbol(serviceErrors().get(0));
                w.importFrom(err.getNamespace(), "ErrorCode");
                names.add("ErrorCode");
            }
            for (String n : List.of("SDK_MODEL", "__version__")) {
                w.importFrom(module("_version"), n);
                names.add(n);
            }
            for (String n : List.of("AsyncEventStream", "AsyncPaginator", "CaitlynAuthError", "CaitlynConnectionError", "CaitlynError", "CallContext", "EventStream",
                    "FileInput", "Interceptor", "NotSupportedByServer", "Paginator", "ReadersShorthand", "ReadersSpecific",
                    "ResponseMetadata", "RetryPolicy", "Started", "AsyncStarted", "BatchFiles", "BatchUpload", "StreamLostError", "SyncCancelledError", "SyncFile", "SyncInterrupted", "SyncPlan", "IngestionProgress", "WaitTimeoutError",
                    "SyncReport", "UploadFile", "UploadId")) {
                w.importFrom(CORE, n);
                names.add(n);
            }
            model.shapes().filter(s -> !s.isMemberShape()).sorted().forEach(s -> {
                if (s.isStructureShape() && s.hasTrait(software.amazon.smithy.model.traits.ErrorTrait.class) && inService(s)) {
                    add(w, names, symbols.toSymbol(s));
                } else if (s.isStructureShape() && facts.isGenerated((StructureShape) s) && inService(s)) {
                    add(w, names, symbols.toSymbol(s));
                } else if ((s.isEnumShape() || s.isIntEnumShape()) && inService(s)) {
                    add(w, names, symbols.toSymbol(s));
                } else if (s.isUnionShape() && facts.sseUnions.contains(s.getId())) {
                    add(w, names, symbols.toSymbol(s));
                    ((UnionShape) s).getAllMembers().values().forEach(m -> {
                        String cls = facts.eventClassNames.get(m.getId());
                        w.importFrom(symbols.toSymbol(s).getNamespace(), cls);
                        names.add(cls);
                    });
                }
            });
            w.write("__all__ = [");
            w.indent();
            new TreeSet<>(names).forEach(n -> w.write("$L,", Names.pyString(n)));
            w.dedent();
            w.write("]");
        });
    }

    private boolean inService(Shape s) {
        return s.getId().getNamespace().equals(service.getId().getNamespace());
    }

    private static void add(PythonWriter w, List<String> names, Symbol s) {
        if (!names.contains(s.getName())) {
            w.importFrom(s.getNamespace(), s.getName());
            names.add(s.getName());
        }
    }

    private void writePyproject() {
        String text = """
                # Generated by caitlyn-python-codegen. DO NOT EDIT.
                [project]
                name = "%s"
                version = "%s"
                description = "Python SDK for the %s (v3)."
                readme = "README.md"
                license = "Apache-2.0"
                authors = [{ name = "Custom D Ltd" }]
                requires-python = ">=3.12"
                dependencies = [
                  "caitlyn-core==%s",
                  "httpx>=0.28,<0.29",
                  "pydantic>=2.11,<3",
                  "opentelemetry-api>=1.38,<2",
                ]

                [project.urls]
                Homepage = "https://build.caitlyn.ai/"
                Documentation = "https://build.caitlyn.ai/"
                Repository = "https://github.com/caitlyn-ai/sdk"

                [build-system]
                requires = ["hatchling"]
                build-backend = "hatchling.build"

                [tool.hatch.build]
                ignore-vcs = true

                [tool.hatch.build.targets.wheel]
                packages = ["%s"]
                """.formatted(settings.distribution(), settings.version(), title, settings.version(), settings.packageName());
        ctx.fileManifest().writeFile("pyproject.toml", text);
    }

    // The package's PyPI page (pyproject.toml's readme). Public text: what the package is, how to install and call it,
    // and where the documentation is.
    private void writeReadme() {
        String text = """
                # %1$s

                The Python SDK for the %2$s (v3): typed clients, synchronous (`Caitlyn`) and asynchronous
                (`AsyncCaitlyn`), with sign-in, retries, streamed answers and OpenTelemetry tracing.

                ```sh
                pip install %1$s
                ```

                ```python
                import os

                from %3$s import Caitlyn
                from %3$s.auth import Token

                caitlyn = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))

                # Add a file to a knowledge base: the SDK hashes and uploads it, creates the document, then waits until it is searchable
                kb = caitlyn.knowledge_bases("KB4T7YQ2WL")
                doc = kb.documents.create("leave-policy.pdf", folder="/hr/").wait()
                print(doc.id, doc.status)
                ```

                Python 3.12 and later. The documentation, with getting started and every operation, is at
                https://build.caitlyn.ai/. The source is at https://github.com/caitlyn-ai/sdk. Apache-2.0.
                """.formatted(settings.distribution(), title, settings.packageName());
        ctx.fileManifest().writeFile("README.md", text);
    }

    static boolean isHeader(MemberShape m) {
        return m.hasTrait(HttpHeaderTrait.class);
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
