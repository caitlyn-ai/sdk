package ai.caitlyn.codegen.cli;

import ai.caitlyn.codegen.model.CaitlynTraits;
import ai.caitlyn.codegen.model.ScopeTree;
import ai.caitlyn.codegen.model.SseEvents;
import ai.caitlyn.codegen.model.Versions;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.PaginatedIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.node.ArrayNode;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.EnumShape;
import software.amazon.smithy.model.shapes.IntEnumShape;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MapShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.DefaultTrait;
import software.amazon.smithy.model.traits.DeprecatedTrait;
import software.amazon.smithy.model.traits.DocumentationTrait;
import software.amazon.smithy.model.traits.ExamplesTrait;
import software.amazon.smithy.model.traits.HttpErrorTrait;
import software.amazon.smithy.model.traits.HttpTrait;
import software.amazon.smithy.model.traits.IdempotencyTokenTrait;
import software.amazon.smithy.model.traits.IdempotentTrait;
import software.amazon.smithy.model.traits.LengthTrait;
import software.amazon.smithy.model.traits.PatternTrait;
import software.amazon.smithy.model.traits.RangeTrait;
import software.amazon.smithy.model.traits.ReadonlyTrait;
import software.amazon.smithy.model.traits.RequiredTrait;
import software.amazon.smithy.model.traits.SensitiveTrait;
import software.amazon.smithy.model.traits.StreamingTrait;
import software.amazon.smithy.model.traits.TitleTrait;

/**
 * The Caitlyn CLI's command manifest ({@code commands.json}): every command, built from the scope tree the SDKs use
 * (PROTOCOL.md section 10), and every operation with its HTTP bindings, members and traits.
 *
 * <p>The grammar (the CLI design, section 2.1):
 * <ul>
 *   <li>nouns are the tree's collections, namespaces and named scopes, in kebab-case, nested as the tree nests them;</li>
 *   <li>verbs are the SDK method names, in kebab-case;</li>
 *   <li>a method on a scope takes the scope's own identifier as its positional argument, and every identifier above it
 *       as a flag; methods anywhere else take every identifier as a flag;</li>
 *   <li>an agent and its version together are one value in the compact form {@code AGENT@version}.</li>
 * </ul>
 *
 * <p>The CLI applies its naming overlay (cli/naming.yaml) to what this writes: flag names, aliases and table columns
 * are the CLI's own choices and are not in the model.
 */
public final class CommandManifest {

    /** Increase when the manifest's shape changes in a way the CLI must know about. */
    public static final int SCHEMA_VERSION = 1;

    static final ShapeId PERMISSION = ShapeId.from("ai.caitlyn.traits#permission");
    static final ShapeId NO_PERMISSION = ShapeId.from("ai.caitlyn.traits#noPermission");
    static final ShapeId INTERACTIVE_ONLY = ShapeId.from("ai.caitlyn.traits#interactiveSessionOnly");
    static final ShapeId FILTERABLE = ShapeId.from("ai.caitlyn.traits#filterable");
    static final ShapeId SORTABLE = ShapeId.from("ai.caitlyn.traits#sortable");
    static final ShapeId IMPACT = ShapeId.from("ai.caitlyn.traits#impact");
    static final String AGENT_ID = "agentId";
    static final String VERSION = "version";

    private final Model model;
    private final ServiceShape service;
    private final String version;
    private final ScopeTree tree;
    private final HttpBindingIndex http;
    private final OperationIndex ops;
    private final PaginatedIndex pages;
    private final Map<String, String> permissions = new TreeMap<>();
    private final Map<String, ObjectNode> shapes = new TreeMap<>();
    private final Map<String, ShapeId> shapeNames = new LinkedHashMap<>();
    private final Map<String, ObjectNode> operations = new TreeMap<>();
    private final List<ObjectNode> commands = new ArrayList<>();
    /** Command path ("knowledge-bases documents get") to what it runs, to refuse two commands at one path. */
    private final Map<String, String> paths = new LinkedHashMap<>();

    public CommandManifest(Model model, ServiceShape service, String version) {
        this.model = model;
        this.service = service;
        this.version = version;
        this.tree = ScopeTree.of(model, service);
        this.http = HttpBindingIndex.of(model);
        this.ops = OperationIndex.of(model);
        this.pages = PaginatedIndex.of(model);
        model.getMetadataProperty("caitlynPermissions").flatMap(Node::asObjectNode)
                .flatMap(o -> o.getObjectMember("permissions"))
                .ifPresent(p -> p.getMembers().forEach((k, v) -> v.asObjectNode()
                        .flatMap(o -> o.getMember("scope")).flatMap(Node::asStringNode)
                        .ifPresent(s -> permissions.put(k.getValue(), s.getValue()))));
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            if (!"internal".equals(CaitlynTraits.stability(op))) {
                operations.put(op.getId().getName(), operation(op));
            }
        }
        visit(tree.root, List.of(), List.of(), false);
    }

    /** {@code CommandManifest <model.json> <out.json> [version]}: the manifest for a model file. */
    public static void main(String[] args) throws java.io.IOException {
        Model model = Model.assembler().discoverModels().addImport(Path.of(args[0])).assemble().unwrap();
        ServiceShape service = model.getServiceShapes().iterator().next();
        String v = args.length > 2 ? args[2] : "0.0.0";
        Files.writeString(Path.of(args[1]), Node.prettyPrintJson(new CommandManifest(model, service, v).toNode()) + "\n");
    }

    public ObjectNode toNode() {
        ObjectNode.Builder b = ObjectNode.builder()
                .withMember("schemaVersion", SCHEMA_VERSION)
                .withMember("version", version)
                .withMember("modelVersion", Versions.modelVersion(model, service))
                .withMember("service", service.getId().getName());
        ObjectNode.Builder perms = ObjectNode.builder();
        permissions.forEach((k, v) -> perms.withMember(k, v));
        b.withMember("permissions", perms.build());
        b.withMember("commands", ArrayNode.fromNodes(commands.stream().map(n -> (Node) n).toList()));
        ObjectNode.Builder o = ObjectNode.builder();
        operations.forEach((k, v) -> o.withMember(k, (Node) v));
        b.withMember("operations", o.build());
        ObjectNode.Builder s = ObjectNode.builder();
        shapes.forEach((k, v) -> s.withMember(k, (Node) v));
        b.withMember("shapes", s.build());
        return b.build();
    }

    // ------------------------------------------------------------------------------------------------ commands

    /**
     * @param nouns  the command path so far
     * @param own    the identifiers a method on this node takes as its positional argument (a scope's own)
     * @param hidden under {@code core}: generated, but left out of help listings
     */
    private void visit(ScopeTree.Node n, List<String> nouns, List<String> own, boolean hidden) {
        for (ScopeTree.Method m : n.methods) {
            command(n, nouns, m.name, m.operation.getId().getName(), fillsOf(m.fills), n.kind == ScopeTree.Kind.SCOPE ? own : List.of(),
                    hidden, m, null);
        }
        if (n.kind == ScopeTree.Kind.SCOPE && n.watch.isPresent()) {
            ScopeTree.LongRunning w = n.watch.get();
            List<String> held = n.identifiers.stream().filter(i -> i.fixed().isEmpty()).map(ScopeTree.Identifier::name).toList();
            boolean hasWatch = n.methods.stream().anyMatch(m -> m.name.equals("watch"));
            if (w.filter().isPresent() && !n.identifiers.isEmpty() && !hasWatch) {
                // kb.documents(id).watch(): the knowledge base's watch, filtered to this thing (as scripts/docs-scopes.mjs places it)
                List<ScopeTree.Fill> fills = new ArrayList<>();
                for (int i = 0; i < n.identifiers.size() - 1; i++) {
                    String id = n.identifiers.get(i).name();
                    fills.add(new ScopeTree.Fill(id, id, false));
                }
                String last = n.identifiers.get(n.identifiers.size() - 1).name();
                fills.add(new ScopeTree.Fill(w.filter().get(), last, false));
                command(n, nouns, "watch", w.watch().getName(), fillsOf(fills), own, hidden, null, null);
            }
            // wait: the scope's wait(), a watch that starts with a snapshot and ends when nothing runs on the thing
            List<ScopeTree.Fill> fills = new ArrayList<>();
            for (String id : held) {
                fills.add(new ScopeTree.Fill(id, id, false));
            }
            command(n, nouns, "wait", null, fillsOf(fills), own, hidden, null, w);
        }
        for (ScopeTree.Node c : n.children.values()) {
            boolean h = hidden || (n.kind == ScopeTree.Kind.ROOT && c.name.equals("core"));
            List<String> next = new ArrayList<>(nouns);
            next.add(kebab(c.name));
            if (c.kind == ScopeTree.Kind.SCOPE) {
                // A named scope (agent.draft) or a singleton (kb.access, events): its methods take the parent scope's own
                visit(c, next, n.kind == ScopeTree.Kind.SCOPE ? own : List.of(), h);
            } else {
                visit(c, next, List.of(), h);
            }
        }
        if (n.kind == ScopeTree.Kind.COLLECTION && n.scope != null) {
            // The scope a call makes: its methods sit beside the collection's, under the same noun
            // Only the identifier the call adds last is positional; any before it (core's knowledge base) are flags
            List<String> ids = n.identifiers.stream().map(ScopeTree.Identifier::name).toList();
            visit(n.scope, nouns, ids.isEmpty() ? List.of() : List.of(ids.get(ids.size() - 1)), hidden);
        }
    }

    /** identifier -> the members it fills, in the order the method lists them. */
    private static Map<String, List<ScopeTree.Fill>> fillsOf(List<ScopeTree.Fill> fills) {
        Map<String, List<ScopeTree.Fill>> out = new LinkedHashMap<>();
        for (ScopeTree.Fill f : fills) {
            out.computeIfAbsent(f.identifier(), k -> new ArrayList<>()).add(f);
        }
        return out;
    }

    private void command(ScopeTree.Node n, List<String> nouns, String methodName, String operation,
            Map<String, List<ScopeTree.Fill>> fills, List<String> own, boolean hidden, ScopeTree.Method m, ScopeTree.LongRunning waits) {
        // A named scope's fixed identifiers (agent.draft's version) hold for everything below it too
        Map<String, String> fixed = new LinkedHashMap<>();
        ScopeTree.Node holder = n;
        while (holder != null && holder.kind != ScopeTree.Kind.SCOPE) {
            holder = holder.parent;
        }
        if (holder != null) {
            for (ScopeTree.Identifier i : holder.identifiers) {
                i.fixed().ifPresent(v -> fixed.put(i.name(), v));
            }
        }
        List<String> positional = new ArrayList<>();
        List<String> flags = new ArrayList<>();
        for (String id : fills.keySet()) {
            if (fixed.containsKey(id)) {
                continue;
            }
            (own.contains(id) ? positional : flags).add(id);
        }
        // AGENT@version: one value where an agent and its version are both given (proposal 4.3)
        boolean compactArg = positional.contains(VERSION) && (positional.contains(AGENT_ID) || flags.contains(AGENT_ID));
        boolean compactFlag = !compactArg && flags.contains(VERSION) && flags.contains(AGENT_ID);
        if (compactArg) {
            positional.remove(AGENT_ID);
            positional.remove(VERSION);
            positional.add(0, AGENT_ID);
            flags.remove(AGENT_ID);
        }
        if (compactFlag) {
            flags.remove(VERSION);
        }

        List<String> path = new ArrayList<>(nouns);
        path.add(kebab(methodName));
        String key = String.join(" ", path);
        String what = operation != null ? operation : "wait";
        String prev = paths.put(key, what);
        if (prev != null) {
            throw new CodegenException("two commands at `caitlyn " + key + "`: " + prev + " and " + what);
        }

        ObjectNode.Builder b = ObjectNode.builder()
                .withMember("path", ArrayNode.fromStrings(path))
                .withMember("place", n.path() + "." + methodName);
        if (operation != null) {
            b.withMember("operation", operation);
        } else {
            b.withMember("kind", "wait");
        }
        if (hidden) {
            b.withMember("hidden", true);
        }
        List<Node> args = new ArrayList<>();
        for (String id : positional) {
            args.add(identifier(id, fills, id.equals(AGENT_ID) && compactArg));
        }
        b.withMember("args", ArrayNode.fromNodes(args));
        List<Node> fl = new ArrayList<>();
        for (String id : flags) {
            fl.add(identifier(id, fills, id.equals(AGENT_ID) && compactFlag));
        }
        b.withMember("identifiers", ArrayNode.fromNodes(fl));
        if (!fixed.isEmpty()) {
            ObjectNode.Builder fb = ObjectNode.builder();
            for (Map.Entry<String, String> e : fixed.entrySet()) {
                List<ScopeTree.Fill> fs = fills.getOrDefault(e.getKey(), List.of());
                for (ScopeTree.Fill f : fs) {
                    fb.withMember(f.member(), e.getValue());
                }
            }
            ObjectNode fixedNode = fb.build();
            if (!fixedNode.isEmpty()) {
                b.withMember("fixed", fixedNode);
            }
        }
        if (m != null) {
            m.longRunning.ifPresent(w -> b.withMember("longRunning", longRunning(w)));
            m.creates.ifPresent(c -> b.withMember("creates", ObjectNode.builder()
                    .withMember("collection", c.collection().path()).withMember("source", c.source()).build()));
            m.estimate.ifPresent(e -> b.withMember("estimate", e.operation.getId().getName()));
            if (m.ifMatchOptional) {
                b.withMember("ifMatchOptional", true);
            }
        }
        if (waits != null) {
            b.withMember("waits", longRunning(waits));
        }
        // The scope's watch, so --wait after this call can follow the thing (a scope's wait())
        if (n.kind == ScopeTree.Kind.SCOPE && n.watch.isPresent()) {
            b.withMember("scopeWatch", longRunning(n.watch.get()));
        }
        commands.add(b.build());
    }

    private static ObjectNode identifier(String id, Map<String, List<ScopeTree.Fill>> fills, boolean compact) {
        ObjectNode.Builder b = ObjectNode.builder().withMember("identifier", id);
        List<Node> members = new ArrayList<>();
        boolean trim = false;
        for (ScopeTree.Fill f : fills.getOrDefault(id, List.of())) {
            members.add(Node.from(f.member()));
            trim |= f.trimSlashes();
        }
        b.withMember("members", ArrayNode.fromNodes(members));
        if (trim) {
            b.withMember("trimSlashes", true);
        }
        if (compact) {
            // AGENT@version: the part after the last @ fills the version's members
            List<Node> vm = new ArrayList<>();
            for (ScopeTree.Fill f : fills.getOrDefault(VERSION, List.of())) {
                vm.add(Node.from(f.member()));
            }
            b.withMember("compact", ObjectNode.builder().withMember("identifier", VERSION)
                    .withMember("members", ArrayNode.fromNodes(vm)).build());
        }
        return b.build();
    }

    private static ObjectNode longRunning(ScopeTree.LongRunning w) {
        ObjectNode.Builder b = ObjectNode.builder().withMember("watch", w.watch().getName());
        w.filter().ifPresent(f -> b.withMember("filter", f));
        if (w.cancels()) {
            b.withMember("cancels", true);
        }
        return b.build();
    }

    // ------------------------------------------------------------------------------------------------ operations

    private ObjectNode operation(OperationShape op) {
        HttpTrait h = op.expectTrait(HttpTrait.class);
        StructureShape input = ops.expectInputShape(op);
        StructureShape output = ops.expectOutputShape(op);
        ObjectNode.Builder b = ObjectNode.builder()
                .withMember("name", op.getId().getName())
                .withMember("method", h.getMethod())
                .withMember("uri", h.getUri().toString())
                .withMember("code", h.getCode())
                .withMember("stability", CaitlynTraits.stability(op));
        op.getTrait(TitleTrait.class).ifPresent(t -> b.withMember("title", t.getValue()));
        op.getTrait(DocumentationTrait.class).ifPresent(t -> b.withMember("documentation", t.getValue()));
        CaitlynTraits.since(op).ifPresent(s -> b.withMember("since", s));
        boolean readonly = op.hasTrait(ReadonlyTrait.class);
        boolean idempotent = op.hasTrait(IdempotentTrait.class);
        if (readonly) {
            b.withMember("readonly", true);
        }
        if (idempotent) {
            b.withMember("idempotent", true);
        }
        op.getTrait(DeprecatedTrait.class).ifPresent(d -> b.withMember("deprecated", d.getMessage().orElse("")));

        Map<String, HttpBinding> bindings = http.getRequestBindings(op);
        List<Node> in = new ArrayList<>();
        boolean retrySafe = readonly || idempotent;
        for (MemberShape m : input.getAllMembers().values()) {
            HttpBinding hb = bindings.get(m.getMemberName());
            if (m.hasTrait(IdempotencyTokenTrait.class)) {
                retrySafe = true;
                if (hb == null || hb.getLocation() != HttpBinding.Location.HEADER) {
                    throw new CodegenException(op.getId() + ": an @idempotencyToken outside a header is not supported");
                }
                b.withMember("idempotencyHeader", hb.getLocationName());
            }
            if (hb != null && hb.getLocation() == HttpBinding.Location.HEADER && hb.getLocationName().equalsIgnoreCase("If-Match")) {
                ObjectNode.Builder im = ObjectNode.builder().withMember("member", m.getMemberName())
                        .withMember("required", m.hasTrait(RequiredTrait.class));
                CaitlynTraits.stringMember(op, ScopeTree.IF_MATCH_OPTIONAL, "reason").ifPresent(r -> im.withMember("reason", r));
                if (op.hasTrait(ScopeTree.IF_MATCH_OPTIONAL)) {
                    im.withMember("optional", true);
                }
                b.withMember("ifMatch", im.build());
            }
            in.add(member(m, hb));
        }
        b.withMember("retrySafe", retrySafe);
        b.withMember("input", ArrayNode.fromNodes(in));

        Map<String, HttpBinding> outBindings = http.getResponseBindings(op);
        List<Node> out = new ArrayList<>();
        for (MemberShape m : output.getAllMembers().values()) {
            out.add(member(m, outBindings.get(m.getMemberName())));
        }
        b.withMember("output", ArrayNode.fromNodes(out));

        pages.getPaginationInfo(service, op).ifPresent(p -> {
            ObjectNode.Builder pb = ObjectNode.builder();
            p.getPaginatedTrait().getInputToken().ifPresent(v -> pb.withMember("inputToken", v));
            p.getPaginatedTrait().getOutputToken().ifPresent(v -> pb.withMember("outputToken", v));
            p.getPaginatedTrait().getItems().ifPresent(v -> pb.withMember("items", v));
            p.getPaginatedTrait().getPageSize().ifPresent(v -> pb.withMember("pageSize", v));
            b.withMember("paginated", pb.build());
        });
        CaitlynTraits.object(op, CaitlynTraits.SSE_EVENTS).ifPresent(sse -> {
            ShapeId union = ShapeId.from(sse.expectStringMember("events").getValue());
            ObjectNode.Builder sb = ObjectNode.builder().withMember("events", ref(union));
            sse.getStringMember("final").ifPresent(f -> sb.withMember("final", f.getValue()));
            sse.getStringMember("resumeWith").ifPresent(f -> sb.withMember("resumeWith", ShapeId.from(f.getValue()).getName()));
            List<Node> names = new ArrayList<>();
            model.expectShape(union).getAllMembers().values().forEach(mm -> names.add(Node.from(SseEvents.wireName(mm))));
            sb.withMember("eventTypes", ArrayNode.fromNodes(names));
            b.withMember("sse", sb.build());
        });
        CaitlynTraits.object(op, ScopeTree.LONG_RUNNING).ifPresent(lr -> {
            ObjectNode.Builder lb = ObjectNode.builder().withMember("watch", ShapeId.from(lr.expectStringMember("watch").getValue()).getName());
            lr.getStringMember("filter").ifPresent(f -> lb.withMember("filter", f.getValue()));
            lr.getBooleanMember("cancels").ifPresent(c -> lb.withMember("cancels", c.getValue()));
            b.withMember("longRunning", lb.build());
        });
        CaitlynTraits.object(op, ScopeTree.ESTIMATE).ifPresent(e -> b.withMember("estimateFor",
                ShapeId.from(e.expectStringMember("for").getValue()).getName()));
        CaitlynTraits.stringMember(op, CaitlynTraits.UPLOAD_TARGET, "member").ifPresent(u -> b.withMember("uploadTarget", u));
        if (op.hasTrait(CaitlynTraits.PRESIGNED_UPLOAD)) {
            b.withMember("presignedUpload", true);
        }
        CaitlynTraits.object(op, PERMISSION).ifPresent(p -> {
            ObjectNode.Builder pb = p.toBuilder();
            p.getStringMember("action").map(a -> permissions.get(a.getValue())).ifPresent(s -> pb.withMember("scope", s));
            List<Node> also = new ArrayList<>();
            p.getArrayMember("alsoActions").ifPresent(a -> a.getElements().forEach(e -> e.asStringNode()
                    .map(sn -> permissions.get(sn.getValue())).ifPresent(s -> also.add(Node.from(s)))));
            if (!also.isEmpty()) {
                pb.withMember("alsoScopes", ArrayNode.fromNodes(also));
            }
            b.withMember("permission", pb.build());
        });
        if (op.hasTrait(NO_PERMISSION)) {
            b.withMember("noPermission", true);
        }
        if (op.hasTrait(INTERACTIVE_ONLY)) {
            b.withMember("interactiveOnly", true);
        }
        CaitlynTraits.node(op, IMPACT).flatMap(Node::asStringNode).ifPresent(s -> b.withMember("impact", s.getValue()));
        CaitlynTraits.object(op, FILTERABLE).ifPresent(f -> b.withMember("filterable", f));
        CaitlynTraits.object(op, SORTABLE).ifPresent(f -> b.withMember("sortable", f));

        List<Node> errors = new ArrayList<>();
        Set<ShapeId> errorIds = new LinkedHashSet<>();
        ops.getErrors(service, op).forEach(e -> errorIds.add(e.getId()));
        for (ShapeId e : errorIds) {
            Shape es = model.expectShape(e);
            ObjectNode.Builder eb = ObjectNode.builder().withMember("shape", e.getName());
            es.getTrait(HttpErrorTrait.class).ifPresent(c -> eb.withMember("status", c.getCode()));
            CaitlynTraits.node(es, CaitlynTraits.ERROR_CODES).flatMap(Node::asArrayNode).ifPresent(a -> eb.withMember("codes", a));
            errors.add(eb.build());
        }
        b.withMember("errors", ArrayNode.fromNodes(errors));

        op.getTrait(ExamplesTrait.class).ifPresent(ex -> {
            List<Node> examples = new ArrayList<>();
            for (ExamplesTrait.Example e : ex.getExamples()) {
                ObjectNode.Builder eb = ObjectNode.builder().withMember("title", e.getTitle());
                e.getDocumentation().ifPresent(d -> eb.withMember("documentation", d));
                eb.withMember("input", e.getInput());
                e.getOutput().ifPresent(o -> eb.withMember("output", o));
                e.getError().ifPresent(er -> eb.withMember("error", ObjectNode.builder()
                        .withMember("shape", er.getShapeId().getName()).withMember("content", er.getContent()).build()));
                examples.add(eb.build());
            }
            b.withMember("examples", ArrayNode.fromNodes(examples));
        });
        return b.build();
    }

    private ObjectNode member(MemberShape m, HttpBinding hb) {
        ObjectNode.Builder b = ObjectNode.builder().withMember("name", m.getMemberName());
        String location = "body";
        String wire = SseEvents.wireName(m);
        if (hb != null) {
            switch (hb.getLocation()) {
                case LABEL -> { location = "label"; wire = hb.getLocationName(); }
                case QUERY -> { location = "query"; wire = hb.getLocationName(); }
                case HEADER -> { location = "header"; wire = hb.getLocationName(); }
                case PAYLOAD -> location = "payload";
                case RESPONSE_CODE -> location = "status";
                case PREFIX_HEADERS, QUERY_PARAMS -> throw new CodegenException(m.getId() + ": " + hb.getLocation() + " bindings are not supported");
                default -> location = "body";
            }
        }
        b.withMember("location", location).withMember("wire", wire);
        Shape target = model.expectShape(m.getTarget());
        if (m.hasTrait(RequiredTrait.class)) {
            b.withMember("required", true);
        }
        Optional<String> doc = m.getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue)
                .or(() -> target.getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue));
        doc.ifPresent(d -> b.withMember("documentation", d));
        b.withMember("type", type(target));
        m.getTrait(DefaultTrait.class).filter(d -> !d.toNode().isNullNode()).ifPresent(d -> b.withMember("default", d.toNode()));
        Optional<RangeTrait> range = m.getTrait(RangeTrait.class).or(() -> target.getTrait(RangeTrait.class));
        range.ifPresent(r -> {
            ObjectNode.Builder rb = ObjectNode.builder();
            r.getMin().ifPresent(v -> rb.withMember("min", Node.from(v)));
            r.getMax().ifPresent(v -> rb.withMember("max", Node.from(v)));
            b.withMember("range", rb.build());
        });
        Optional<LengthTrait> length = m.getTrait(LengthTrait.class).or(() -> target.getTrait(LengthTrait.class));
        length.ifPresent(l -> {
            ObjectNode.Builder lb = ObjectNode.builder();
            l.getMin().ifPresent(v -> lb.withMember("min", v));
            l.getMax().ifPresent(v -> lb.withMember("max", v));
            b.withMember("length", lb.build());
        });
        m.getTrait(PatternTrait.class).or(() -> target.getTrait(PatternTrait.class)).ifPresent(p -> b.withMember("pattern", p.getValue()));
        CaitlynTraits.since(m).ifPresent(s -> b.withMember("since", s));
        if (m.hasTrait(SensitiveTrait.class) || target.hasTrait(SensitiveTrait.class)) {
            b.withMember("sensitive", true);
        }
        if (m.hasTrait(CaitlynTraits.CLEARABLE)) {
            b.withMember("clearable", true);
        }
        if (m.hasTrait(IdempotencyTokenTrait.class)) {
            b.withMember("idempotencyToken", true);
        }
        m.getTrait(DeprecatedTrait.class).ifPresent(d -> b.withMember("deprecated", d.getMessage().orElse("")));
        return b.build();
    }

    /** A member's type: simple types inline, structures and unions by reference into {@code shapes}. */
    private ObjectNode type(Shape s) {
        ObjectNode.Builder b = ObjectNode.builder();
        switch (s.getType()) {
            case STRING -> b.withMember("type", "string");
            case ENUM -> {
                b.withMember("type", "enum");
                b.withMember("values", ArrayNode.fromStrings(new ArrayList<>(((EnumShape) s).getEnumValues().values())));
            }
            case INT_ENUM -> {
                b.withMember("type", "intEnum");
                List<Node> vals = new ArrayList<>();
                ((IntEnumShape) s).getEnumValues().values().forEach(v -> vals.add(Node.from(v)));
                b.withMember("values", ArrayNode.fromNodes(vals));
            }
            case BOOLEAN -> b.withMember("type", "boolean");
            case BYTE, SHORT, INTEGER, LONG, BIG_INTEGER -> b.withMember("type", "integer");
            case FLOAT, DOUBLE, BIG_DECIMAL -> b.withMember("type", "number");
            case TIMESTAMP -> b.withMember("type", "timestamp");
            case BLOB -> {
                b.withMember("type", "blob");
                if (s.hasTrait(StreamingTrait.class)) {
                    b.withMember("streaming", true);
                }
            }
            case DOCUMENT -> b.withMember("type", "document");
            case LIST, SET -> {
                b.withMember("type", "list");
                b.withMember("member", type(model.expectShape(((ListShape) s).getMember().getTarget())));
            }
            case MAP -> {
                MapShape ms = (MapShape) s;
                b.withMember("type", "map");
                b.withMember("value", type(model.expectShape(ms.getValue().getTarget())));
            }
            case STRUCTURE, UNION -> {
                return ref(s.getId());
            }
            default -> throw new CodegenException(s.getId() + ": " + s.getType() + " members are not supported by the CLI");
        }
        return b.build();
    }

    /** A structure or union by reference, registered in {@code shapes} the first time. */
    private ObjectNode ref(ShapeId id) {
        String name = id.getName();
        ShapeId prev = shapeNames.putIfAbsent(name, id);
        if (prev != null && !prev.equals(id)) {
            throw new CodegenException("two shapes are named " + name + ": " + prev + " and " + id);
        }
        if (prev == null) {
            Shape s = model.expectShape(id);
            shapes.put(name, ObjectNode.builder().build()); // placeholder, for recursive shapes
            ObjectNode.Builder b = ObjectNode.builder().withMember("type", s.isUnionShape() ? "union" : "structure");
            s.getTrait(DocumentationTrait.class).ifPresent(d -> b.withMember("documentation", d.getValue()));
            List<Node> members = new ArrayList<>();
            for (MemberShape m : s.getAllMembers().values()) {
                members.add(member(m, null));
            }
            b.withMember("members", ArrayNode.fromNodes(members));
            shapes.put(name, b.build());
        }
        return ObjectNode.builder().withMember("type", "ref").withMember("ref", name).build();
    }

    /** {@code knowledgeBases} to {@code knowledge-bases}; {@code deleteMany} to {@code delete-many}. */
    static String kebab(String camel) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < camel.length(); i++) {
            char c = camel.charAt(i);
            if (Character.isUpperCase(c)) {
                if (i > 0) {
                    sb.append('-');
                }
                sb.append(Character.toLowerCase(c));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
