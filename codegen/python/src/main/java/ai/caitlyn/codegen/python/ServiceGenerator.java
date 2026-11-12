package ai.caitlyn.codegen.python;

import ai.caitlyn.codegen.model.CaitlynTraits;

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
    private final PythonSettings settings;
    private final ModelFacts facts;
    private final software.amazon.smithy.codegen.core.SymbolProvider symbols;
    private final TypeHints hints;
    private final List<OperationInfo> ops = new ArrayList<>();
    private final Map<ShapeId, OperationInfo> byId = new LinkedHashMap<>();
    private final String title;

    ServiceGenerator(GenerationContext ctx, ServiceShape service) {
        this.ctx = ctx;
        this.service = service;
        this.model = ctx.model();
        this.settings = ctx.settings();
        this.facts = ctx.facts();
        this.symbols = ctx.symbolProvider();
        this.hints = new TypeHints(model, symbols, facts);
        this.title = service.getTrait(TitleTrait.class).map(TitleTrait::getValue).orElse(service.getId().getName());
    }

    void run() {
        for (OperationShape op : new TreeSet<>(TopDownIndex.of(model).getContainedOperations(service))) {
            if (CaitlynTraits.stability(op).equals("internal")) {
                continue; // never generated into the public SDKs
            }
            OperationInfo info = new OperationInfo(model, service, op, settings);
            ops.add(info);
            byId.put(op.getId(), info);
        }
        writeOperations();
        writeClient();
        writeVersion();
        writeAuth();
        writeInit();
        ctx.fileManifest().writeFile(settings.packageName() + "/py.typed", "");
        writePyproject();
    }

    private String module(String name) {
        return settings.module(name);
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
            // Where each operation lives on the client: tools that call operations by name (the conformance
            // harness's example cases, later the CLI's `caitlyn api`) read this rather than guess.
            w.write("");
            w.write("METHODS: Final[dict[str, tuple[str, str]]] = {");
            w.indent();
            for (OperationInfo o : ops) {
                w.write("$S: ($S, $S),", o.name, o.namespace, o.method);
            }
            w.dedent();
            w.write("}");
            w.write("\"\"\"Operation name to (client attribute, method name).\"\"\"");
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
        w.write("stability=$L,", Names.pyString(o.stability));
        if (o.kind == OperationInfo.Kind.STREAM) {
            w.write("streaming=True,");
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
        w.write("$L_EVENTS: Final = EventDecoder[$L, $L]($L, $L$L)\n", o.constant, t.unionName, t.finalType, types, fn,
                t.errorEvent.map(e -> ", " + e).orElse(""));
    }

    // ------------------------------------------------------------------ _client.py

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
            if (presigned.output.getMember(m).isEmpty()) {
                throw new CodegenException(presigned.op.getId() + " is a presigned upload but its output has no " + m);
            }
        }
        return Optional.of(new Upload(presigned, targets));
    }

    private void writeClient() {
        Map<String, List<OperationInfo>> namespaces = new TreeMap<>();
        for (OperationInfo o : ops) {
            namespaces.computeIfAbsent(o.namespace, k -> new ArrayList<>()).add(o);
        }
        Optional<Upload> upload = uploads();
        ctx.writerDelegator().useFileWriter(settings.file("_client"), module("_client"), w -> {
            w.write("$D\n", "The " + title + " clients: `Caitlyn` (synchronous) and `AsyncCaitlyn`.");
            w.importModule("httpx");
            for (boolean async : new boolean[] {false, true}) {
                for (Map.Entry<String, List<OperationInfo>> ns : namespaces.entrySet()) {
                    writeResource(w, ns.getKey(), ns.getValue(), async, upload);
                }
            }
            writeClientClass(w, namespaces.keySet(), false);
            writeClientClass(w, namespaces.keySet(), true);
        });
    }

    private static String resourceClass(String namespace, boolean async) {
        String pascal = java.util.Arrays.stream(namespace.split("_")).map(p -> p.isEmpty() ? p : Character.toUpperCase(p.charAt(0)) + p.substring(1)).collect(Collectors.joining());
        return (async ? "Async" : "") + pascal + "Resource";
    }

    private void writeResource(PythonWriter w, String namespace, List<OperationInfo> list, boolean async, Optional<Upload> upload) {
        String core = async ? "AsyncClientCore" : "SyncClientCore";
        w.importFrom(CORE, core);
        w.importFrom(settings.packageName(), "_operations");
        w.write("class $L:", resourceClass(namespace, async));
        w.indent();
        w.write("$D\n", "`" + namespace + "`: " + list.stream().map(o -> o.method).collect(Collectors.joining(", ")) + ".");
        w.write("def __init__(self, core: $L) -> None:", core);
        w.indent().write("self._core = core").dedent();
        for (OperationInfo o : list) {
            w.write("");
            writeMethod(w, o, async);
        }
        if (upload.isPresent()) {
            if (upload.get().presigned.namespace.equals(namespace)) {
                w.write("");
                writeUploadCreate(w, upload.get().presigned, async);
            }
            for (Map.Entry<OperationInfo, String> t : upload.get().targets.entrySet()) {
                if (t.getKey().namespace.equals(namespace)) {
                    w.write("");
                    writeUploadInto(w, upload.get().presigned, t.getKey(), t.getValue(), async);
                }
            }
        }
        w.dedent();
        w.write("\n");
    }

    /** "name: type" or "name: type | None = None", in signature order, with `*` after a positional label. */
    private List<String> signature(OperationInfo o, PythonWriter w, List<String> omit) {
        List<String> out = new ArrayList<>();
        Optional<String> positional = o.positional();
        boolean star = false;
        for (OperationInfo.Param p : o.params) {
            if (omit.contains(p.member().getMemberName())) {
                continue;
            }
            if (p.binding().getLocation() == HttpBinding.Location.PAYLOAD && model.expectShape(p.member().getTarget()).hasTrait(StreamingTrait.class)) {
                throw new CodegenException(o.op.getId() + ": streaming request payloads are not supported yet");
            }
            boolean isPositional = positional.filter(p.member().getMemberName()::equals).isPresent();
            if (!isPositional && !star) {
                out.add("*");
                star = true;
            }
            String type = hints.of(p.member(), TypeHints.Mode.INPUT, w);
            out.add(p.member().isRequired() ? p.name() + ": " + type : p.name() + ": " + type + " | None = None");
        }
        if (!star) {
            out.add("*");
        }
        return out;
    }

    private String paramsDict(OperationInfo o, List<String> omit) {
        return "{" + o.params.stream().filter(p -> !omit.contains(p.member().getMemberName()))
                .map(p -> Names.pyString(p.name()) + ": " + p.name()).collect(Collectors.joining(", ")) + "}";
    }

    private String methodDocs(OperationInfo o) {
        StringBuilder doc = new StringBuilder(CaitlynPythonCodegen.docs(o.op).orElse(o.name + "."));
        List<String> meta = new ArrayList<>();
        o.since.ifPresent(v -> meta.add("Added in Caitlyn " + v + "."));
        if (!o.stability.equals("ga")) {
            meta.add("Stability: " + o.stability + ".");
        }
        meta.add("`" + o.http.getMethod() + " " + o.http.getUri() + "`.");
        doc.append("\n\n").append(String.join(" ", meta));
        List<String> args = new ArrayList<>();
        for (OperationInfo.Param p : o.params) {
            String d = CaitlynPythonCodegen.memberDocs(p.member(), false);
            if (!d.isEmpty()) {
                args.add("    " + p.name() + ": " + d.replace("\n", "\n        "));
            }
        }
        if (!args.isEmpty()) {
            doc.append("\n\nArgs:\n").append(String.join("\n", args));
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

    private void writeMethod(PythonWriter w, OperationInfo o, boolean async) {
        String ops = "_operations";
        switch (o.kind) {
            case UNARY -> {
                String result = typeOf(o.output, w);
                writeDef(w, async, o.method, signature(o, w, List.of()), result);
                w.indent();
                w.write("$D", methodDocs(o));
                call(w, "return " + (async ? "await " : "") + "self._core.request", List.of(ops + "." + o.constant, paramsDict(o, List.of()), result));
                w.dedent();
            }
            case PAGINATED -> {
                PaginationInfo p = o.pagination.orElseThrow();
                if (p.getItemsMemberPath().size() != 1 || p.getOutputTokenMemberPath().size() != 1) {
                    throw new CodegenException(o.op.getId() + ": nested pagination paths are not supported yet");
                }
                String page = typeOf(o.output, w);
                MemberShape items = p.getItemsMemberPath().get(0);
                Shape itemsTarget = model.expectShape(items.getTarget());
                if (!(itemsTarget instanceof ListShape list)) {
                    throw new CodegenException(o.op.getId() + ": paginated items must be a list");
                }
                String item = hints.of(list.getMember(), TypeHints.Mode.MODEL, w);
                String tokenParam = Names.member(p.getInputTokenMember().getMemberName());
                String itemsAttr = Names.field(items.getMemberName()) + (items.isRequired() ? "" : " or []");
                String nextAttr = Names.field(p.getOutputTokenMemberPath().get(0).getMemberName());
                String paginator = async ? "AsyncPaginator" : "Paginator";
                w.importFrom(CORE, paginator);
                List<String> omit = List.of(p.getInputTokenMember().getMemberName());
                writeDef(w, false, o.method, signature(o, w, List.of()), paginator + "[" + page + ", " + item + "]");
                w.indent();
                w.write("$D", methodDocs(o) + "\n\nReturns:\n    A paginator over every item on every page (`.pages()` for the pages). Nothing is requested until it is iterated.");
                String dict = paramsDict(o, omit);
                if (dict.length() + 40 <= 120) {
                    w.write("params: dict[str, object] = $L", dict);
                } else {
                    w.write("params: dict[str, object] = {");
                    w.indent();
                    o.params.stream().filter(p2 -> !omit.contains(p2.member().getMemberName()))
                            .forEach(p2 -> w.write("$L: $L,", Names.pyString(p2.name()), p2.name()));
                    w.dedent();
                    w.write("}");
                }
                w.write("");
                w.write("$Ldef fetch(token: str | None) -> $L:", async ? "async " : "", page);
                w.indent().write("return $Lself._core.request($L.$L, {**params, $L: token}, $L)", async ? "await " : "", ops, o.constant, Names.pyString(tokenParam), page).dedent();
                w.write("");
                w.write("return $L(fetch, lambda page: page.$L, lambda page: page.$L, $L)", paginator, itemsAttr, nextAttr, tokenParam);
                w.dedent();
            }
            case STREAM -> {
                StreamTypes t = streamTypes(o, w);
                String stream = async ? "AsyncEventStream" : "EventStream";
                w.importFrom(CORE, stream);
                writeDef(w, false, o.method, signature(o, w, List.of()), stream + "[" + t.unionName + ", " + t.finalType + "]");
                w.indent();
                w.write("$D", methodDocs(o) + "\n\nReturns:\n    The event stream: `with` it, iterate it, then `final_message()`. Unknown event types are skipped;"
                        + " a dropped connection is resumed with Last-Event-ID.");
                w.write("return self._core.stream(");
                w.indent();
                w.write("$L.$L,", ops, o.constant);
                w.write("$L,", paramsDict(o, List.of()));
                w.write("$L.$L_EVENTS,", ops, o.constant);
                resume(o, w).ifPresent(r -> w.write("$L,", r));
                w.dedent();
                w.write(")");
                w.dedent();
            }
        }
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
                carried.add(Names.pyString(p.name()) + ": " + o.param(p.member().getMemberName()).get().name());
            } else if (p.member().isRequired()) {
                throw new CodegenException(r.op.getId() + " resumes " + o.op.getId() + " but needs " + p.member().getMemberName() + ", which " + o.name + " does not take");
            }
        }
        if (lastId == null) {
            throw new CodegenException(r.op.getId() + " has no member bound to the Last-Event-ID header");
        }
        w.importFrom(CORE, "Resume");
        return Optional.of("Resume(_operations." + r.constant + ", {" + String.join(", ", carried) + "}, " + Names.pyString(lastId) + ")");
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

    private String typeOf(StructureShape output, PythonWriter w) {
        Symbol s = symbols.toSymbol(output);
        w.importFrom(s.getNamespace(), s.getName());
        return s.getName();
    }

    private void writeUploadCreate(PythonWriter w, OperationInfo presigned, boolean async) {
        String result = typeOf(presigned.output, w);
        w.importFrom(CORE, "read_upload");
        w.importFrom("os", "PathLike");
        List<String> sig = new ArrayList<>(List.of("*", "file: str | PathLike[str] | bytes", "file_name: str | None = None", "content_type: str | None = None"));
        List<String> passthrough = passThrough(presigned, sig, w, List.of("fileName", "contentType", "byteSize", "sha256"));
        writeDef(w, async, "create", sig, result);
        w.indent();
        w.write("$D", "Reserve an upload and send the file's bytes to its presigned URL, checksum included.\n\n"
                + "Calls `" + presigned.method + "` and then sends the bytes (with no Caitlyn credentials) to the URL it returns.\n\n"
                + "Args:\n    file: a path, or the bytes themselves (then pass `file_name`).\n"
                + "    content_type: guessed from the file name when not given.");
        writeReserve(w, presigned, async, passthrough);
        w.write("return reservation");
        w.dedent();
    }

    private void writeReserve(PythonWriter w, OperationInfo presigned, boolean async, List<String> passthrough) {
        w.write("upload = read_upload(file, file_name=file_name, content_type=content_type)");
        String params = "{\"file_name\": upload.file_name, \"content_type\": upload.content_type, \"byte_size\": upload.byte_size, \"sha256\": upload.sha256"
                + passthrough.stream().map(p -> ", " + Names.pyString(p) + ": " + p).collect(Collectors.joining()) + "}";
        call(w, "reservation = " + (async ? "await " : "") + "self._core.request", List.of("_operations." + presigned.constant, params, typeOf(presigned.output, w)));
        w.write("$Lself._core.put_presigned(reservation.upload_method, reservation.upload_url, reservation.required_headers, upload.data)",
                async ? "await " : "");
    }

    /** Optional members of an operation that a helper passes straight through (e.g. idempotency_key). */
    private List<String> passThrough(OperationInfo o, List<String> sig, PythonWriter w, List<String> handled) {
        List<String> out = new ArrayList<>();
        for (OperationInfo.Param p : o.params) {
            if (handled.contains(p.member().getMemberName())) {
                continue;
            }
            if (p.member().isRequired()) {
                throw new CodegenException(o.op.getId() + ": the upload helper cannot fill required member " + p.member().getMemberName());
            }
            sig.add(p.name() + ": " + hints.of(p.member(), TypeHints.Mode.INPUT, w) + " | None = None");
            out.add(p.name());
        }
        return out;
    }

    private void writeUploadInto(PythonWriter w, OperationInfo presigned, OperationInfo target, String uploadMember, boolean async) {
        String result = typeOf(target.output, w);
        w.importFrom(CORE, "read_upload");
        w.importFrom("os", "PathLike");
        List<String> sig = new ArrayList<>(signature(target, w, List.of(uploadMember)));
        int star = sig.indexOf("*");
        sig.add(star + 1, "file: str | PathLike[str] | bytes");
        sig.add("file_name: str | None = None");
        sig.add("content_type: str | None = None");
        writeDef(w, async, "upload", sig, result);
        w.indent();
        w.write("$D", "Uploads a file, then calls `" + target.method + "`: " + CaitlynPythonCodegen.docs(target.op).orElse(target.name + ".")
                + "\n\nReserves an upload (`" + presigned.namespace + "." + presigned.method + "`), sends the bytes to the presigned URL, then calls `"
                + target.method + "` with the upload's ID.");
        writeReserve(w, presigned, async, List.of());
        List<String> args = new ArrayList<>();
        for (OperationInfo.Param p : target.params) {
            String value = p.member().getMemberName().equals(uploadMember) ? "reservation.id" : p.name();
            args.add(p.name() + "=" + value);
        }
        call(w, "return " + (async ? "await " : "") + "self." + target.method, args);
        w.dedent();
    }

    private void writeClientClass(PythonWriter w, java.util.Set<String> namespaces, boolean async) {
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
                + "    tracer_provider: OpenTelemetry tracer provider (default: the global one).\n"
                + "    interceptors: hooks run around every call and attempt.\n"
                + "    app_id: your application's name, sent in the user agent as `app/<app_id>`.\n"
                + "    http_client: your own httpx client, for its transport, proxy or TLS settings. Requests go to the workspace or `endpoint`; its `base_url` is not used.";
        w.write("$D\n", doc);
        w.write("auth: $L", async ? "AsyncAuthSession" : "SyncAuthSession");
        w.write("$D", "The client's sign-in: the `OAuth` mode's `authorization_url`, `handle_callback` and `sign_out`, and the current token.");
        for (String ns : namespaces) {
            w.write("$L: $L", ns, resourceClass(ns, async));
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
        w.write("timeout: float | httpx.Timeout = 60.0,");
        w.write("tracer_provider: TracerProvider | None = None,");
        w.write("interceptors: Sequence[Interceptor] = (),");
        w.write("app_id: str | None = None,");
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
        w.write("tracer_provider=tracer_provider,");
        w.write("interceptors=interceptors,");
        w.write("app_id=app_id,");
        w.dedent();
        w.write(")");
        w.write("self._core = $L(config, http_client)", core);
        w.write("self.auth = self._core.auth");
        for (String ns : namespaces) {
            w.write("self.$L = $L(self._core)", ns, resourceClass(ns, async));
        }
        w.dedent();
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
                    "ClientCredentials", "OAuth", "OAuthTokens", "Session", "SyncAuthSession", "Token", "TokenStore", "WorkloadIdentity");
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
            for (String n : List.of("SDK_MODEL", "__version__")) {
                w.importFrom(module("_version"), n);
                names.add(n);
            }
            for (String n : List.of("AsyncEventStream", "AsyncPaginator", "CaitlynAuthError", "CaitlynConnectionError", "CaitlynError", "CallContext", "EventStream",
                    "Interceptor", "NotSupportedByServer", "Paginator", "ResponseMetadata", "RetryPolicy", "StreamLostError")) {
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
                requires-python = ">=3.12"
                dependencies = [
                  "caitlyn-core==%s",
                  "httpx>=0.28,<0.29",
                  "pydantic>=2.11,<3",
                  "opentelemetry-api>=1.38,<2",
                ]

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
