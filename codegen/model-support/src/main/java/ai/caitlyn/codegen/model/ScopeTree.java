package ai.caitlyn.codegen.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.HttpLabelTrait;
import software.amazon.smithy.model.traits.HttpPayloadTrait;

/**
 * The client as scopes (PROTOCOL.md section 10), computed once from the resource tree for every generator and the
 * docs: the collections, the scopes they make, the named scopes ({@code agent.draft}, {@code agent.live}), the
 * plain namespaces between them ({@code kb.ingestion}), the building blocks under {@code core}, and each method with
 * the identifiers its scope fills in.
 *
 * <p>Names are the model's lower camel case; each generator spells them in its language (TypeScript and Python call
 * a collection with an identifier; Go and Rust call the collection's {@link Node#singular} method on the parent).
 */
public final class ScopeTree {

    public static final ShapeId SCOPE = ShapeId.from("ai.caitlyn.traits#scope");
    public static final ShapeId SCOPE_ALIASES = ShapeId.from("ai.caitlyn.traits#scopeAliases");
    public static final ShapeId FROM_SCOPE = ShapeId.from("ai.caitlyn.traits#fromScope");
    public static final ShapeId LONG_RUNNING = ShapeId.from("ai.caitlyn.traits#longRunning");
    public static final ShapeId ESTIMATE = ShapeId.from("ai.caitlyn.traits#estimate");
    public static final ShapeId LOW_LEVEL = ShapeId.from("ai.caitlyn.traits#lowLevel");
    public static final ShapeId IF_MATCH_OPTIONAL = ShapeId.from("ai.caitlyn.traits#ifMatchOptional");

    /** What a node is in the client. */
    public enum Kind {
        /** The client itself. */
        ROOT,
        /** A plain property that only groups (`kb.ingestion`, `caitlyn.agents.options`, `caitlyn.core`). */
        NAMESPACE,
        /** A collection: callable with its scope's own identifiers, and holding the collection's methods. */
        COLLECTION,
        /** One thing, made by calling a collection; or a named scope (an alias) or a singleton, reached as a property. */
        SCOPE
    }

    /**
     * An identifier a scope holds.
     *
     * @param name   the resource identifier's name, which is also the input member it fills ({@code knowledgeBaseId})
     * @param fixed  the value of a named scope's identifier ({@code "draft"} for {@code agent.draft}); empty when the
     *               caller gives it
     */
    public record Identifier(String name, Optional<String> fixed) {}

    /**
     * An input member a scope fills.
     *
     * @param member      the operation's input member
     * @param identifier  the scope identifier whose value goes there
     * @param trimSlashes the value is a folder path sent in a request path: the SDK sends it without its first and
     *                    last {@code /} (a folder scope takes {@code '/hr/leave/'} as people write it)
     */
    public record Fill(String member, String identifier, boolean trimSlashes) {}

    /** {@code @longRunning}: the watch that follows the work, and the watch's input member the identifier fills. */
    /**
     * {@code cancels}: the call cancels the work it follows ({@code @longRunning(cancels: true)}), so its wait() returns the
     * thing once that work has stopped, and the job it cancelled ending {@code cancelled} is not a failure (wait.cancel-returns).
     */
    public record LongRunning(ShapeId watch, Optional<String> filter, boolean cancels) {}

    /**
     * Where the scope a {@code create} returns gets its identifier: {@code output:id}, {@code output:document.id}
     * or {@code input:path} (a dotted member path into the call's output or input).
     */
    public record NewScope(Node collection, String source) {}

    /** A method on a node. */
    public static final class Method {
        public final OperationShape operation;
        public final String name;
        /** Input members filled from the scope (or, under core, from the leading arguments). */
        public final List<Fill> fills;
        /** Under {@code core}: the identifiers taken as leading arguments, outermost first. Empty elsewhere. */
        public final List<String> leading;
        /** The work the call starts is followed through this watch ({@code @longRunning} on the operation). */
        public final Optional<LongRunning> longRunning;
        /** For a create of a resource with an identifier: the scope it returns. */
        public Optional<NewScope> creates = Optional.empty();
        /** The estimate placed beside this job ({@code @estimate(for: …)}): {@code job.estimate} or {@code EstimateJob}. */
        public Optional<Method> estimate = Optional.empty();
        /** {@code If-Match} is bound but not required ({@code @ifMatchOptional}). */
        public final boolean ifMatchOptional;

        Method(OperationShape operation, String name, List<Fill> fills, List<String> leading) {
            this.operation = operation;
            this.name = name;
            this.fills = List.copyOf(fills);
            this.leading = List.copyOf(leading);
            this.longRunning = longRunning(operation);
            this.ifMatchOptional = operation.findTrait(IF_MATCH_OPTIONAL).isPresent();
        }

        /** The input members the scope does not fill: what the caller passes. */
        public boolean fills(String member) {
            return fills.stream().anyMatch(f -> f.member().equals(member));
        }
    }

    /** A node of the client tree. */
    public static final class Node {
        public final Kind kind;
        /** The property or collection name under the parent, lower camel case ({@code documents}, {@code draft}). */
        public final String name;
        public final Node parent;
        public final Optional<ResourceShape> resource;
        /** COLLECTION: the scope method's name in Go and Rust ({@code document}, {@code batch}). */
        public String singular = "";
        /** SCOPE: every identifier the scope holds, outermost first. COLLECTION: the identifiers a call adds. */
        public final List<Identifier> identifiers = new ArrayList<>();
        public final List<Method> methods = new ArrayList<>();
        public final Map<String, Node> children = new LinkedHashMap<>();
        /** COLLECTION: the scope calling it makes. */
        public Node scope;
        /** SCOPE: {@code watch()} and {@code wait()} follow the thing through this watch. */
        public Optional<LongRunning> watch = Optional.empty();
        /** SCOPE made by an alias: the alias name ({@code draft}); empty for a scope made by a call or a singleton. */
        public Optional<String> alias = Optional.empty();

        Node(Kind kind, String name, Node parent, Optional<ResourceShape> resource) {
            this.kind = kind;
            this.name = name;
            this.parent = parent;
            this.resource = resource;
        }

        /** The node's place, for messages and the docs: {@code knowledgeBases(knowledgeBaseId).documents}. */
        public String path() {
            if (parent == null) return "caitlyn";
            String up = parent.path();
            if (kind == Kind.SCOPE && parent.kind == Kind.COLLECTION) {
                return up + "(" + String.join(", ", parent.identifiers.stream().map(Identifier::name).toList()) + ")";
            }
            return up + "." + name;
        }

        /** A child property by name, made when missing. */
        Node child(Kind kind, String name, Optional<ResourceShape> resource) {
            Node existing = children.get(name);
            if (existing != null) {
                if (existing.kind != kind && !(existing.kind == Kind.NAMESPACE || kind == Kind.NAMESPACE)) {
                    throw new CodegenException(path() + "." + name + " is both a " + existing.kind + " and a " + kind);
                }
                return existing;
            }
            Node n = new Node(kind, name, this, resource);
            children.put(name, n);
            return n;
        }

        /** Walks a dotted namespace below this node, making plain namespaces as needed. */
        Node at(List<String> segments) {
            Node n = this;
            for (String s : segments) {
                Node next = n.children.get(s);
                n = next != null ? next : n.child(Kind.NAMESPACE, s, Optional.empty());
            }
            return n;
        }

        /** Every node at and below this one, depth first. */
        public List<Node> walk() {
            List<Node> out = new ArrayList<>();
            out.add(this);
            for (Node c : children.values()) out.addAll(c.walk());
            if (scope != null) out.addAll(scope.walk());
            return out;
        }
    }

    public final Node root;
    private final Model model;
    private final Map<ShapeId, ResourceShape> parentOf = new LinkedHashMap<>();
    private final Map<ShapeId, Method> placed = new LinkedHashMap<>();
    private final Map<ShapeId, List<Node>> scopesOf = new LinkedHashMap<>();
    private final List<OperationShape> estimates = new ArrayList<>();

    private ScopeTree(Model model, ServiceShape service) {
        this.model = model;
        this.root = new Node(Kind.ROOT, "", null, Optional.empty());
        for (ResourceShape r : model.getResourceShapes()) {
            for (ShapeId child : r.getResources()) parentOf.put(child, r);
        }
        for (ShapeId id : service.getResources()) attach(root, model.expectShape(id, ResourceShape.class), List.of());
        for (ShapeId id : service.getOperations()) placeUnbound(model.expectShape(id, OperationShape.class));
        placeFromScope(service);
        placeEstimates();
        placeCreatesElsewhere();
        Set.check(this, service, model);
    }

    /**
     * Writes the tree of a model file as JSON: {@code ScopeTree <model.json> <out.json>}. scripts/generate.sh runs it to
     * write conformance/cases/scope-tree.json, which the docs scripts and the harnesses read.
     */
    public static void main(String[] args) throws java.io.IOException {
        Model model = Model.assembler().discoverModels().addImport(java.nio.file.Path.of(args[0])).assemble().unwrap();
        ScopeTree tree = of(model, model.getServiceShapes().iterator().next());
        java.nio.file.Files.writeString(java.nio.file.Path.of(args[1]), software.amazon.smithy.model.node.Node.prettyPrintJson(tree.toNode()) + "\n");
    }

    /** The tree for a service's model. */
    public static ScopeTree of(Model model, ServiceShape service) {
        return new ScopeTree(model, service);
    }

    /** Where an operation is placed: its method; every public operation has one. */
    public Optional<Method> method(OperationShape op) {
        return Optional.ofNullable(placed.get(op.getId()));
    }

    /** The scope nodes a resource is offered on, the alias scopes included. */
    public List<Node> scopes(ResourceShape r) {
        return scopesOf.getOrDefault(r.getId(), List.of());
    }

    // ------------------------------------------------------------------------------------------------ building

    private void attach(Node parent, ResourceShape r, List<Identifier> inherited) {
        if (r.findTrait(LOW_LEVEL).isPresent()) {
            attachCore(r, inherited);
            return;
        }
        List<String> own = new ArrayList<>(r.getIdentifiers().keySet());
        own.removeIf(i -> inherited.stream().anyMatch(x -> x.name().equals(i)));
        Optional<ObjectNode> scopeTrait = r.findTrait(SCOPE).map(t -> t.toNode().expectObjectNode());
        List<String> collectionPath = List.of(scopeTrait.flatMap(t -> t.getStringMember("collection")).map(n -> n.getValue())
                .orElseGet(() -> ClientMethod.plural(ownName(r))).split("\\."));
        Node holder = parent.at(collectionPath.subList(0, collectionPath.size() - 1));
        String last = collectionPath.get(collectionPath.size() - 1);

        Node scope;
        Node collection;
        if (own.isEmpty()) {
            // A singleton (an agent's draft, a knowledge base's access): a scope reached as a property. When a sibling's
            // alias of the same name exists, the two are one scope (PROTOCOL.md 10).
            scope = holder.children.containsKey(last) && holder.children.get(last).kind == Kind.SCOPE
                    ? holder.children.get(last) : holder.child(Kind.SCOPE, last, Optional.of(r));
            if (scope.identifiers.isEmpty()) scope.identifiers.addAll(inherited);
            collection = scope;
        } else {
            collection = holder.child(Kind.COLLECTION, last, Optional.of(r));
            collection.singular = scopeTrait.flatMap(t -> t.getStringMember("singular")).map(n -> n.getValue())
                    .orElseGet(() -> lowerFirst(ownName(r)));
            for (String i : own) collection.identifiers.add(new Identifier(i, Optional.empty()));
            scope = new Node(Kind.SCOPE, last, collection, Optional.of(r));
            collection.scope = scope;
            scope.identifiers.addAll(inherited);
            scope.identifiers.addAll(collection.identifiers);
        }
        scope.watch = longRunning(r);
        scopesOf.computeIfAbsent(r.getId(), k -> new ArrayList<>()).add(scope);

        // The collection's methods: list, create and the collection operations
        List<ShapeId> onCollection = new ArrayList<>();
        r.getList().ifPresent(onCollection::add);
        r.getCreate().ifPresent(onCollection::add);
        onCollection.addAll(new TreeSet<>(r.getCollectionOperations()));
        for (ShapeId opId : onCollection) place(collection, r, model.expectShape(opId, OperationShape.class), inherited);

        // The scope's methods: get, update, delete, put and the instance operations
        List<ShapeId> onScope = new ArrayList<>();
        r.getRead().ifPresent(onScope::add);
        r.getUpdate().ifPresent(onScope::add);
        r.getDelete().ifPresent(onScope::add);
        r.getPut().ifPresent(onScope::add);
        onScope.addAll(new TreeSet<>(r.getOperations()));
        for (ShapeId opId : onScope) place(scope, r, model.expectShape(opId, OperationShape.class), scope.identifiers);

        // Named scopes (`agent.draft`, `agent.live`): the scope's methods with the last identifier fixed
        r.findTrait(SCOPE_ALIASES).ifPresent(t -> {
            for (Map.Entry<String, software.amazon.smithy.model.node.Node> e : t.toNode().expectObjectNode().getStringMap().entrySet()) {
                ObjectNode alias = e.getValue().expectObjectNode();
                String value = alias.expectStringMember("value").getValue();
                List<String> without = alias.getArrayMember("without").map(a -> a.getElements().stream()
                        .map(n -> ShapeId.from(n.expectStringNode().getValue()).getName()).toList()).orElse(List.of());
                Node named = parent.children.containsKey(e.getKey()) ? parent.children.get(e.getKey())
                        : parent.child(Kind.SCOPE, e.getKey(), Optional.of(r));
                named.alias = Optional.of(e.getKey());
                List<Identifier> ids = new ArrayList<>(inherited);
                for (String i : own) ids.add(new Identifier(i, i.equals(own.get(own.size() - 1)) ? Optional.of(value) : Optional.empty()));
                if (named.identifiers.isEmpty() || named.identifiers.size() < ids.size()) {
                    named.identifiers.clear();
                    named.identifiers.addAll(ids);
                }
                named.watch = named.watch.or(() -> longRunning(r));
                scopesOf.get(r.getId()).add(named);
                for (ShapeId opId : onScope) {
                    OperationShape op = model.expectShape(opId, OperationShape.class);
                    if (!without.contains(op.getId().getName())) place(named, r, op, named.identifiers, false);
                }
            }
        });

        for (ShapeId child : r.getResources()) attach(scope, model.expectShape(child, ResourceShape.class), scope.identifiers);
    }

    private void attachCore(ResourceShape r, List<Identifier> inherited) {
        Node core = root.child(Kind.NAMESPACE, "core", Optional.empty());
        List<String> all = new ArrayList<>(r.getIdentifiers().keySet());
        Optional<ObjectNode> scopeTrait = r.findTrait(SCOPE).map(t -> t.toNode().expectObjectNode());
        String name = scopeTrait.flatMap(t -> t.getStringMember("collection")).map(n -> n.getValue())
                .orElseGet(() -> ClientMethod.plural(ownName(r)));
        Node collection = core.child(Kind.COLLECTION, name, Optional.of(r));
        collection.singular = scopeTrait.flatMap(t -> t.getStringMember("singular")).map(n -> n.getValue())
                .orElseGet(() -> lowerFirst(ownName(r)));
        // A building block's scope takes every identifier it needs: `core.operations(kbId, operationId)`.
        for (String i : all) collection.identifiers.add(new Identifier(i, Optional.empty()));
        Node scope = new Node(Kind.SCOPE, name, collection, Optional.of(r));
        collection.scope = scope;
        scope.identifiers.addAll(collection.identifiers);
        scope.watch = longRunning(r);
        scopesOf.computeIfAbsent(r.getId(), k -> new ArrayList<>()).add(scope);
        List<String> parentIds = inherited.stream().map(Identifier::name).toList();
        List<ShapeId> onCollection = new ArrayList<>();
        r.getList().ifPresent(onCollection::add);
        r.getCreate().ifPresent(onCollection::add);
        onCollection.addAll(new TreeSet<>(r.getCollectionOperations()));
        for (ShapeId opId : onCollection) {
            OperationShape op = model.expectShape(opId, OperationShape.class);
            // The collection's calls take the parents' identifiers first: `core.operations.list(kbId, …)`.
            Method m = new Method(op, methodName(op, r), fillsFor(op, inherited), parentIds);
            add(collection, op, List.of(), m);
        }
        List<ShapeId> onScope = new ArrayList<>();
        r.getRead().ifPresent(onScope::add);
        r.getUpdate().ifPresent(onScope::add);
        r.getDelete().ifPresent(onScope::add);
        r.getPut().ifPresent(onScope::add);
        onScope.addAll(new TreeSet<>(r.getOperations()));
        for (ShapeId opId : onScope) {
            OperationShape op = model.expectShape(opId, OperationShape.class);
            add(scope, op, List.of(), new Method(op, methodName(op, r), fillsFor(op, scope.identifiers), List.of()));
        }
    }

    private void place(Node node, ResourceShape r, OperationShape op, List<Identifier> ids) {
        place(node, r, op, ids, true);
    }

    private void place(Node node, ResourceShape r, OperationShape op, List<Identifier> ids, boolean primary) {
        if (op.findTrait(ESTIMATE).isPresent()) {
            if (primary) estimates.add(op);
            return;
        }
        if (op.findTrait(LOW_LEVEL).isPresent()) {
            if (primary) placeCore(op, r, ids);
            return;
        }
        List<String> ns = clientNamespace(op).map(n -> List.of(n.split("\\."))).orElse(List.of());
        Method m = new Method(op, methodName(op, r), fillsFor(op, ids), List.of());
        if (isCreateOf(op, r) && node.kind == Kind.COLLECTION) {
            m.creates = Optional.of(new NewScope(node, newScopeSource(op, r, node)));
        }
        add(node, op, ns, m, primary);
    }

    private void placeCore(OperationShape op, ResourceShape r, List<Identifier> ids) {
        Node core = root.child(Kind.NAMESPACE, "core", Optional.empty());
        List<String> ns = clientNamespace(op).map(n -> List.of(n.split("\\."))).orElse(List.of());
        // A building block takes the identifiers its place gives as leading arguments: an instance operation all of its
        // resource's (`core.ingestion.completeUploads(kbId, batchId, …)`), a collection operation its parents'
        // (`core.ingestion.addItems(kbId, batchId, items)`).
        Method m = new Method(op, methodName(op, r), fillsFor(op, ids), ids.stream().map(Identifier::name).toList());
        add(core, op, ns, m);
    }

    private void placeUnbound(OperationShape op) {
        if (op.findTrait(LOW_LEVEL).isPresent()) {
            Method m = new Method(op, methodName(op, null), List.of(), List.of());
            add(root.child(Kind.NAMESPACE, "core", Optional.empty()), op, clientNamespace(op).map(n -> List.of(n.split("\\."))).orElse(List.of()), m);
            return;
        }
        String name = CaitlynTraits.stringMember(op, CaitlynTraits.CLIENT_METHOD, "name")
                .orElseThrow(() -> new CodegenException(op.getId() + " is bound to no resource and has no @clientMethod name"));
        List<String> ns = clientNamespace(op).map(n -> List.of(n.split("\\."))).orElse(List.of());
        // An unbound operation's namespace is absolute, and may run through a collection (`caitlyn.agents.options`).
        add(root, op, ns, new Method(op, name, List.of(), List.of()));
    }

    /** {@code @fromScope}: the operation is also offered on the named resource's scopes, at the same place. */
    private void placeFromScope(ServiceShape service) {
        for (OperationShape op : new TreeSet<>(TopDownIndex.of(model).getContainedOperations(service))) {
            StructureShape input = model.expectShape(op.getInputShape(), StructureShape.class);
            Method home = placed.get(op.getId());
            if (home == null) continue;
            for (MemberShape member : input.getAllMembers().values()) {
                Optional<ShapeId> target = member.findTrait(FROM_SCOPE).map(t -> ShapeId.from(t.toNode().expectStringNode().getValue()));
                if (target.isEmpty()) continue;
                ResourceShape owner = model.expectShape(target.get(), ResourceShape.class);
                String ownerId = lastIdentifier(owner);
                Node homeNode = nodeOf(home);
                // The same path below the scope as below the operation's own scope: `kb.access.get()` gives
                // `kb.folders(path).access.get()`.
                List<String> relative = relativeTo(homeNode);
                for (Node scope : scopes(owner)) {
                    List<Fill> fills = new ArrayList<>(fillsFor(op, scope.identifiers));
                    fills.removeIf(f -> f.member().equals(member.getMemberName()));
                    fills.add(new Fill(member.getMemberName(), ownerId, isFolderLabel(member, owner)));
                    Node at = scope.at(relative);
                    at.methods.add(new Method(op, home.name, fills, List.of()));
                }
            }
        }
    }

    /** {@code @estimate(for: Job)}: beside the job, with the job's place and fills. */
    private void placeEstimates() {
        for (OperationShape est : estimates) {
            ShapeId job = ShapeId.from(CaitlynTraits.stringMember(est, ESTIMATE, "for").orElseThrow());
            Method jobMethod = placed.get(job);
            if (jobMethod == null) throw new CodegenException(est.getId() + ": @estimate names " + job + ", which has no client method");
            Node at = nodeOf(jobMethod);
            Method m = new Method(est, jobMethod.name, fillsFor(est, at.kind == Kind.SCOPE ? at.identifiers
                    : at.kind == Kind.COLLECTION ? at.scope.identifiers.subList(0, at.scope.identifiers.size() - at.identifiers.size())
                    : scopeIdentifiersAbove(at)), jobMethod.leading);
            jobMethod.estimate = Optional.of(m);
            placed.put(est.getId(), m);
            nodes.put(m, at);
        }
    }

    /**
     * A {@code create} bound to another resource that makes a thing of its own (CreateConversation, bound to the agent's
     * version, makes a conversation): it returns that thing's scope, from the top-level collection that reopens it
     * ({@code caitlyn.conversations(id)}). The thing is the one resource whose read returns the same body members as the
     * create (ConversationBody, as both outputs share it; compared by member, as generators see mixins flattened).
     */
    private void placeCreatesElsewhere() {
        for (Node n : root.walk()) {
            for (Method m : n.methods) {
                if (!m.name.equals("create") || m.creates.isPresent() || !m.leading.isEmpty()) continue;
                java.util.Set<String> created = bodyMembers(m.operation);
                List<ResourceShape> owners = new ArrayList<>();
                for (ResourceShape r : model.getResourceShapes()) {
                    if (r.getIdentifiers().isEmpty() || r.getRead().isEmpty() || scopes(r).isEmpty()) continue;
                    if (bodyMembers(model.expectShape(r.getRead().get(), OperationShape.class)).equals(created)) owners.add(r);
                }
                if (owners.size() != 1) continue;
                ResourceShape r = owners.get(0);
                Node collection = scopes(r).stream().map(sc -> sc.parent).filter(p -> p != null && p.kind == Kind.COLLECTION && p.scope != null)
                        .findFirst().orElse(null);
                if (collection == null || collection.identifiers.size() != collection.scope.identifiers.size()) continue;
                m.creates = Optional.of(new NewScope(collection, newScopeSource(m.operation, r, collection)));
            }
        }
    }

    /** An operation's output members that travel in the body (not headers), by name. */
    private java.util.Set<String> bodyMembers(OperationShape op) {
        java.util.Set<String> out = new java.util.TreeSet<>();
        for (MemberShape mm : model.expectShape(op.getOutputShape(), StructureShape.class).getAllMembers().values()) {
            if (mm.hasTrait(software.amazon.smithy.model.traits.HttpHeaderTrait.class) || mm.hasTrait(software.amazon.smithy.model.traits.HttpResponseCodeTrait.class)) continue;
            out.add(mm.getMemberName());
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------------ helpers

    private final Map<Method, Node> nodes = new LinkedHashMap<>();

    private void add(Node node, OperationShape op, List<String> ns, Method m) {
        add(node, op, ns, m, true);
    }

    private void add(Node node, OperationShape op, List<String> ns, Method m, boolean primary) {
        Node at = node.at(ns);
        if (at.methods.stream().anyMatch(x -> x.name.equals(m.name))) {
            throw new CodegenException(at.path() + "." + m.name + " is given to two operations, " + op.getId().getName() + " among them");
        }
        at.methods.add(m);
        nodes.put(m, at);
        if (primary) placed.putIfAbsent(op.getId(), m);
    }

    /** The node a placed method is on. */
    public Node nodeOf(Method m) {
        return nodes.get(m);
    }

    private static List<String> relativeTo(Node n) {
        List<String> path = new ArrayList<>();
        Node cur = n;
        while (cur != null && cur.kind == Kind.NAMESPACE) {
            path.add(0, cur.name);
            cur = cur.parent;
        }
        if (cur != null && cur.kind == Kind.SCOPE && cur.parent != null && cur.parent.kind != Kind.COLLECTION && cur.resource.isPresent()
                && cur.alias.isEmpty() && cur.resource.get().getIdentifiers().size() == cur.identifiers.size()) {
            // A singleton (Access): its own name is part of the path below the parent scope.
            path.add(0, cur.name);
        }
        return path;
    }

    private static List<Identifier> scopeIdentifiersAbove(Node n) {
        Node cur = n;
        while (cur != null && cur.kind != Kind.SCOPE) cur = cur.parent;
        return cur == null ? List.of() : cur.identifiers;
    }

    private List<Fill> fillsFor(OperationShape op, List<Identifier> ids) {
        StructureShape input = model.expectShape(op.getInputShape(), StructureShape.class);
        List<Fill> fills = new ArrayList<>();
        for (Identifier id : ids) {
            input.getMember(id.name()).ifPresent(m -> fills.add(new Fill(id.name(), id.name(), isFolderLabelName(m, id.name()))));
        }
        return fills;
    }

    private boolean isFolderLabel(MemberShape member, ResourceShape owner) {
        return member.hasTrait(HttpLabelTrait.class) && owner.getId().getName().equals("Folder");
    }

    private boolean isFolderLabelName(MemberShape member, String identifier) {
        return member.hasTrait(HttpLabelTrait.class) && identifier.equals("folderPath");
    }

    private static String lastIdentifier(ResourceShape r) {
        List<String> ids = new ArrayList<>(r.getIdentifiers().keySet());
        return ids.get(ids.size() - 1);
    }

    private static boolean isCreateOf(OperationShape op, ResourceShape r) {
        return r.getCreate().filter(op.getId()::equals).isPresent() && !r.getIdentifiers().isEmpty();
    }

    /** Where a create's new scope gets its identifier: the output's member, its `id`, a nested `<thing>.id`, or the input. */
    private String newScopeSource(OperationShape op, ResourceShape r, Node collection) {
        String id = collection.identifiers.get(collection.identifiers.size() - 1).name();
        StructureShape output = model.expectShape(op.getOutputShape(), StructureShape.class);
        StructureShape input = model.expectShape(op.getInputShape(), StructureShape.class);
        String bare = id.replaceFirst("^[a-z]+(?=[A-Z])", "");
        String bareLower = bare.isEmpty() ? id : lowerFirst(bare);
        if (output.getMember(id).isPresent()) return "output:" + id;
        if (output.getMember("id").isPresent()) return "output:id";
        String thing = lowerFirst(ownName(r));
        Optional<MemberShape> nested = output.getMember(thing);
        if (nested.isPresent()) {
            Shape t = model.expectShape(nested.get().getTarget());
            if (t.asStructureShape().flatMap(s -> s.getMember("id")).isPresent()) return "output:" + thing + ".id";
        }
        // One type per thing: the output's @httpPayload is the new thing, whatever the member is called (`batch`)
        Optional<MemberShape> payload = output.getAllMembers().values().stream().filter(m -> m.hasTrait(HttpPayloadTrait.class)).findFirst();
        if (payload.isPresent() && model.expectShape(payload.get().getTarget()).asStructureShape().flatMap(s -> s.getMember("id")).isPresent()) {
            return "output:" + payload.get().getMemberName() + ".id";
        }
        if (input.getMember(id).isPresent()) return "input:" + id;
        if (input.getMember(bareLower).isPresent()) return "input:" + bareLower;
        if (output.getMember(bareLower).isPresent()) return "output:" + bareLower;
        throw new CodegenException(op.getId() + ": cannot tell where the new " + r.getId().getName() + "'s " + id + " comes from");
    }

    private static Optional<String> clientNamespace(OperationShape op) {
        return CaitlynTraits.stringMember(op, CaitlynTraits.CLIENT_METHOD, "namespace");
    }

    private static String methodName(OperationShape op, ResourceShape r) {
        Optional<String> name = CaitlynTraits.stringMember(op, CaitlynTraits.CLIENT_METHOD, "name");
        if (name.isPresent()) return name.get();
        if (r != null) {
            if (r.getCreate().filter(op.getId()::equals).isPresent()) return "create";
            if (r.getRead().filter(op.getId()::equals).isPresent()) return "get";
            if (r.getUpdate().filter(op.getId()::equals).isPresent()) return "update";
            if (r.getDelete().filter(op.getId()::equals).isPresent()) return "delete";
            if (r.getList().filter(op.getId()::equals).isPresent()) return "list";
            if (r.getPut().filter(op.getId()::equals).isPresent()) return "put";
            return ClientMethod.instanceMethod(op.getId().getName(), r);
        }
        return lowerFirst(op.getId().getName());
    }

    private static Optional<LongRunning> longRunning(Shape s) {
        return s.findTrait(LONG_RUNNING).map(t -> {
            ObjectNode n = t.toNode().expectObjectNode();
            return new LongRunning(ShapeId.from(n.expectStringMember("watch").getValue()), n.getStringMember("filter").map(x -> x.getValue()),
                    n.getBooleanMember("cancels").map(x -> x.getValue()).orElse(false));
        });
    }

    /** A resource's own name under its parent: {@code DocumentVersion} under {@code DocumentResource} is {@code Version}. */
    private String ownName(ResourceShape r) {
        String n = r.getId().getName().replaceFirst("Resource$", "");
        ResourceShape p = parentOf.get(r.getId());
        if (p == null) return n;
        String pn = p.getId().getName().replaceFirst("Resource$", "");
        return n.startsWith(pn) && n.length() > pn.length() && Character.isUpperCase(n.charAt(pn.length())) ? n.substring(pn.length()) : n;
    }

    private static String lowerFirst(String s) {
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    // ------------------------------------------------------------------------------------------------ checks

    /** Every public operation is placed once, and no method shares its name with a property beside it. */
    private static final class Set {
        static void check(ScopeTree tree, ServiceShape service, Model model) {
            List<String> missing = new ArrayList<>();
            for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
                if (CaitlynTraits.stability(op).equals("internal")) continue;
                if (!tree.placed.containsKey(op.getId())) missing.add(op.getId().getName());
            }
            if (!missing.isEmpty()) throw new CodegenException("operations with no client method: " + String.join(", ", missing));
            for (Node n : tree.root.walk()) {
                for (Method m : n.methods) {
                    if (n.children.containsKey(m.name)) throw new CodegenException(n.path() + "." + m.name + " is both a method and a property");
                }
            }
            // Every SDK names a scope's type <Resource>Scope (Go and Rust exactly so; TypeScript and Python may prefix
            // the parent). A model shape of that name would collide with it, and a generator would rename one of them.
            java.util.Set<String> shapes = new java.util.HashSet<>();
            model.shapes().filter(s -> s.getId().getNamespace().equals(service.getId().getNamespace())).forEach(s -> shapes.add(s.getId().getName()));
            List<String> clashes = new ArrayList<>();
            for (Node n : tree.root.walk()) {
                if (n.kind != Kind.SCOPE || n.resource.isEmpty()) continue;
                String scopeType = n.resource.get().getId().getName().replaceFirst("Resource$", "") + "Scope";
                if (shapes.contains(scopeType)) clashes.add(scopeType + " (" + n.path() + ")");
            }
            if (!clashes.isEmpty()) {
                throw new CodegenException("model shapes share a name with a scope's type, which every SDK calls <Resource>Scope: " + String.join(", ", clashes));
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ JSON

    /** The tree as JSON, for the docs scripts and the conformance harnesses (conformance/cases/scope-tree.json). */
    public ObjectNode toNode() {
        return nodeJson(root);
    }

    private ObjectNode nodeJson(Node n) {
        ObjectNode.Builder b = ObjectNode.builder().withMember("kind", n.kind.name().toLowerCase()).withMember("path", n.path());
        if (!n.name.isEmpty()) b.withMember("name", n.name);
        n.resource.ifPresent(r -> b.withMember("resource", r.getId().getName()));
        if (!n.singular.isEmpty()) b.withMember("singular", n.singular);
        n.alias.ifPresent(a -> b.withMember("alias", a));
        if (!n.identifiers.isEmpty()) {
            b.withMember("identifiers", software.amazon.smithy.model.node.Node.fromNodes(n.identifiers.stream().map(i -> {
                ObjectNode.Builder ib = ObjectNode.builder().withMember("name", i.name());
                i.fixed().ifPresent(f -> ib.withMember("fixed", f));
                return (software.amazon.smithy.model.node.Node) ib.build();
            }).toList()));
        }
        n.watch.ifPresent(w -> b.withMember("watch", longRunningJson(w)));
        if (!n.methods.isEmpty()) {
            b.withMember("methods", software.amazon.smithy.model.node.Node.fromNodes(n.methods.stream()
                    .map(m -> (software.amazon.smithy.model.node.Node) methodJson(m)).toList()));
        }
        if (!n.children.isEmpty()) {
            ObjectNode.Builder cb = ObjectNode.builder();
            n.children.forEach((k, v) -> cb.withMember(k, nodeJson(v)));
            b.withMember("children", cb.build());
        }
        if (n.scope != null) b.withMember("scope", nodeJson(n.scope));
        return b.build();
    }

    private ObjectNode methodJson(Method m) {
        ObjectNode.Builder b = ObjectNode.builder().withMember("name", m.name).withMember("operation", m.operation.getId().getName());
        if (!m.fills.isEmpty()) {
            b.withMember("fills", software.amazon.smithy.model.node.Node.fromNodes(m.fills.stream().map(f -> {
                ObjectNode.Builder fb = ObjectNode.builder().withMember("member", f.member()).withMember("identifier", f.identifier());
                if (f.trimSlashes()) fb.withMember("trimSlashes", true);
                return (software.amazon.smithy.model.node.Node) fb.build();
            }).toList()));
        }
        if (!m.leading.isEmpty()) b.withMember("leading", software.amazon.smithy.model.node.Node.fromStrings(m.leading));
        m.longRunning.ifPresent(w -> b.withMember("longRunning", longRunningJson(w)));
        m.creates.ifPresent(c -> b.withMember("creates", ObjectNode.builder().withMember("collection", c.collection().path())
                .withMember("source", c.source()).build()));
        m.estimate.ifPresent(e -> b.withMember("estimate", e.operation.getId().getName()));
        if (m.ifMatchOptional) b.withMember("ifMatchOptional", true);
        return b.build();
    }

    private static ObjectNode longRunningJson(LongRunning w) {
        ObjectNode.Builder b = ObjectNode.builder().withMember("watch", w.watch().getName());
        w.filter().ifPresent(f -> b.withMember("filter", f));
        if (w.cancels()) b.withMember("cancels", true);
        return b.build();
    }
}
