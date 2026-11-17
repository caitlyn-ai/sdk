package ai.caitlyn.codegen.rust;

import ai.caitlyn.codegen.model.ScopeTree;
import ai.caitlyn.codegen.model.ScopeTree.Kind;
import ai.caitlyn.codegen.model.ScopeTree.Node;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.shapes.EnumShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;

/**
 * Writes src/client.rs: the client as scopes (PROTOCOL.md 10), from {@link ScopeTree}. Rust cannot call a value that
 * also has methods, so a collection is two methods on its parent: the plural one returns the collection
 * ({@code client.knowledge_bases().list()}) and the singular one, with the identifier, the scope
 * ({@code client.knowledge_base(id)}). Named scopes and singletons are methods too ({@code agent.draft()},
 * {@code kb.access()}). Every node is a small struct holding the client and the identifiers it fills in; a scope the
 * model watches also has {@code watch()} and {@code wait()} (PROTOCOL.md 16).
 */
final class ScopeWriter {
    private final ServiceGenerator g;
    private final Map<Node, String> names = new IdentityHashMap<>();
    /** Scopes a delete's wait follows: they get {@code follow_gone}. */
    private final Set<Node> goneTargets = java.util.Collections.newSetFromMap(new IdentityHashMap<>());
    /** Model shape names a client type also has: src/scope.rs names those shapes with their module. */
    private final Set<String> shadowed = new HashSet<>();

    ScopeWriter(ServiceGenerator g) {
        this.g = g;
        Map<String, Node> seen = new HashMap<>();
        // Scopes first, so that the calls under a scope are named after the scope's final name.
        for (boolean scopesPass : List.of(true, false)) {
            for (Node n : g.tree.root.walk()) {
                if (n.kind == Kind.ROOT) {
                    names.put(n, "Client");
                    continue;
                }
                if ((n.kind == Kind.SCOPE) != scopesPass) {
                    continue;
                }
                String name = n.kind == Kind.SCOPE ? shortName(n, false) : scopeName(nearestScope(n.parent)) + pascalPath(n);
                Node clash = seen.get(name);
                if (clash != null && n.kind == Kind.SCOPE && clash.kind == Kind.SCOPE) {
                    // Two scopes with one singular (an agent's version and a document's): both named after their parents too.
                    names.put(clash, shortName(clash, true));
                    seen.put(shortName(clash, true), clash);
                    name = shortName(n, true);
                }
                if (seen.containsKey(name) && seen.get(name) != n) {
                    throw new CodegenException("the client type " + name + " (" + n.path() + ") is given twice");
                }
                seen.put(name, n);
                names.put(n, name);
            }
        }
        // A scope's type is `…Scope` (KnowledgeBaseScope), so the thing keeps its own name (KnowledgeBase). The calls
        // and collections under it were named from the scope's name without the suffix, above.
        seen.clear();
        for (Node n : g.tree.root.walk()) {
            if (n.kind == Kind.SCOPE) {
                names.put(n, names.get(n) + "Scope");
            }
            if (names.containsKey(n)) {
                Node clash = seen.put(names.get(n), n);
                if (clash != null && clash != n) {
                    throw new CodegenException("the client type " + names.get(n) + " (" + n.path() + ") is given twice");
                }
            }
        }
        g.model.shapes().forEach(s -> {
            if (seen.containsKey(Names.pascal(s.getId().getName()))) {
                shadowed.add(Names.pascal(s.getId().getName()));
            }
        });
        for (List<ServiceGenerator.Placed> places : g.placements.values()) {
            for (ServiceGenerator.Placed p : places) {
                OperationInfo op = g.info(p.method().operation.getId());
                if (p.method().longRunning.isPresent() && p.method().creates.isEmpty() && g.isDelete(op)) {
                    goneTargets.add(g.followScope(p));
                }
            }
        }
    }

    private static Node nearestScope(Node n) {
        while (n.kind != Kind.SCOPE && n.kind != Kind.ROOT) {
            n = n.parent;
        }
        return n;
    }

    /** A scope's short name: its singular ({@code Document}), or for a named scope or a singleton its parent's and its own. */
    private String shortName(Node scope, boolean qualified) {
        if (scope.kind == Kind.ROOT) {
            return "";
        }
        if (scope.parent.kind == Kind.COLLECTION) {
            String own = Names.pascal(scope.parent.singular);
            return qualified ? shortName(nearestScope(scope.parent.parent), false) + own : own;
        }
        return shortName(nearestScope(scope.parent), false) + Names.pascal(scope.name);
    }

    /** A scope's final name, or "" for the client. */
    private String scopeName(Node scope) {
        return scope.kind == Kind.ROOT ? "" : names.get(scope);
    }

    /** The names from the nearest scope above a node down to it: {@code IngestionBatches} for {@code kb.ingestion.batches}. */
    private static String pascalPath(Node n) {
        List<String> parts = new ArrayList<>();
        for (Node cur = n; cur.kind != Kind.SCOPE && cur.kind != Kind.ROOT; cur = cur.parent) {
            parts.add(0, Names.pascal(cur.name));
        }
        return String.join("", parts);
    }

    String typeName(Node n) {
        return names.get(n);
    }

    /** A client type as other modules name it. */
    String qualified(Node n) {
        return "crate::scope::" + names.get(n);
    }

    /** A type of the model's as src/scope.rs names it: with its module where a client type has the same name. */
    String ty(String name) {
        return shadowed.contains(name) ? "crate::types::" + name : name;
    }

    /** The identifiers a node's struct holds: a scope's own, a collection's or a namespace's from the scope above. */
    List<String> contextIds(Node n) {
        return switch (n.kind) {
            case ROOT -> List.of();
            case SCOPE -> n.identifiers.stream().map(ScopeTree.Identifier::name).toList();
            case COLLECTION -> {
                List<String> all = new ArrayList<>(n.scope.identifiers.stream().map(ScopeTree.Identifier::name).toList());
                all.removeAll(n.identifiers.stream().map(ScopeTree.Identifier::name).toList());
                yield all;
            }
            case NAMESPACE -> contextIds(n.parent);
        };
    }

    /** How a place reads in Rust: {@code client.knowledge_base(knowledge_base_id).documents().create(…)}. */
    String rustPath(ServiceGenerator.Placed p) {
        List<String> parts = new ArrayList<>();
        for (Node cur = p.node(); cur.kind != Kind.ROOT; cur = cur.parent) {
            if (cur.kind == Kind.SCOPE && cur.parent.kind == Kind.COLLECTION) {
                parts.add(0, Names.segment(cur.parent.singular) + "(…)");
                cur = cur.parent;
            } else {
                parts.add(0, Names.segment(cur.name) + "()");
            }
        }
        String method = p.job().map(j -> "estimate_" + Names.segment(j.name)).orElse(Names.segment(p.method().name));
        parts.add(0, "client");
        return String.join(".", parts) + "." + method + "(…)";
    }

    // ------------------------------------------------------------------ what a watched scope's wait returns

    private OperationInfo watchOp(Node scope) {
        return g.info(scope.watch.orElseThrow().watch());
    }

    private UnionShape events(Node scope) {
        return g.model.expectShape(ShapeId.from(watchOp(scope).sse.orElseThrow().expectStringMember("events").getValue()), UnionShape.class);
    }

    /**
     * The snapshot member that holds the thing: the watch's filter name (`document`, `folder`, `batch`), never the
     * resource's name (IngestionBatchResource's thing is `batch`). A scope watched with no filter is the knowledge base
     * itself, under `knowledgeBase`.
     */
    private String thingKey(Node scope) {
        return scope.watch.get().filter().orElseGet(() -> {
            if (!scope.resource.orElseThrow().getId().getName().equals("KnowledgeBaseResource")) {
                throw new CodegenException(scope.path() + ": a watch with no filter is only the knowledge base's own");
            }
            return "knowledgeBase";
        });
    }

    private MemberShape thingMember(Node scope) {
        MemberShape snapshot = events(scope).getMember("snapshot")
                .orElseThrow(() -> new CodegenException(events(scope).getId() + ": a watch followed by wait() needs a snapshot event"));
        StructureShape s = g.model.expectShape(snapshot.getTarget(), StructureShape.class);
        return s.getMember(thingKey(scope))
                .orElseThrow(() -> new CodegenException(s.getId() + " has no member " + thingKey(scope) + " for " + scope.path()));
    }

    private Optional<ScopeTree.Method> getMethod(Node scope) {
        return scope.methods.stream().filter(m -> m.name.equals("get")).findFirst();
    }

    String waitType(Node scope) {
        return "crate::types::" + getMethod(scope).map(m -> g.resultType(g.info(m.operation.getId())))
                .orElseGet(() -> g.ctx.types().base(g.model.expectShape(thingMember(scope).getTarget())));
    }

    /** The thing is a document: its progress is its DocumentProcessing, not a job. */
    private boolean isDocument(Node scope) {
        return thingKey(scope).equals("document");
    }

    /** A batch: its thing has a status that can be {@code planned}. */
    private boolean plans(Node scope) {
        Shape t = g.model.expectShape(thingMember(scope).getTarget());
        return t.asStructureShape().flatMap(s -> s.getMember("status")).map(m -> g.model.expectShape(m.getTarget()))
                .filter(Shape::isEnumShape).map(e -> ((EnumShape) e).getEnumValues().containsValue("planned")).orElse(false);
    }

    /** The deleted event's member that names the thing, and the scope identifier it matches. */
    private Optional<String> goneWhen(Node scope) {
        Optional<String> filter = scope.watch.get().filter();
        if (filter.isEmpty()) {
            return Optional.empty();
        }
        return events(scope).getMember(filter.get() + "Deleted").map(m -> {
            StructureShape s = g.model.expectShape(m.getTarget(), StructureShape.class);
            MemberShape first = s.getAllMembers().values().stream().filter(MemberShape::isRequired).findFirst()
                    .orElseThrow(() -> new CodegenException(s.getId() + " names nothing"));
            return ModelFacts.wireName(first);
        });
    }

    // ------------------------------------------------------------------ writing

    void run() {
        g.ctx.writerDelegator().useFileWriter("src/scope.rs", "", w -> {
            w.l("#![allow(unused_mut, clippy::doc_lazy_continuation, clippy::field_reassign_with_default, clippy::needless_update, clippy::new_ret_no_self)]\n\n"
                    + "//! The client as a tree of scopes (PROTOCOL.md 10): [`Client`] at the top, a collection's plural method beside its\n"
                    + "//! singular one (`client.knowledge_bases()` and `client.knowledge_base(id)`), named scopes (`agent.draft()`) and\n"
                    + "//! namespaces (`kb.ingestion()`). Making any of them sends nothing.\n\n"
                    + "use std::time::Duration;\n\nuse caitlyn_sdk_core as rt;\n\nuse crate::error::Error;\nuse crate::operations::*;\nuse crate::types::*;\n\n");
            client(w);
            for (Node n : g.tree.root.walk()) {
                if (n.kind != Kind.ROOT && !empty(n)) {
                    node(w, n);
                }
            }
            uploads(w);
            sync(w);
        });
    }

    /** A collection with no calls of its own (conversations, which are listed from an agent): only its scope is offered. */
    private static boolean empty(Node n) {
        return n.kind == Kind.COLLECTION && n.methods.isEmpty() && n.children.isEmpty();
    }

    private String ctxFields(Node n) {
        StringBuilder b = new StringBuilder();
        for (String id : contextIds(n)) {
            b.append("    pub(crate) ").append(Names.snake(id)).append(": String,\n");
        }
        return b.toString();
    }

    private String selfIds(Node n) {
        List<String> out = new ArrayList<>();
        for (String id : contextIds(n)) {
            out.add("self." + Names.snake(id) + ".clone()");
        }
        return "vec![" + String.join(", ", out) + "]";
    }

    private String describe(Node n) {
        return switch (n.kind) {
            case SCOPE -> n.alias.isPresent() ? "The named scope `" + n.path() + "`: the same as a version scope with its name fixed."
                    : "A scope, `" + n.path() + "`: one thing, with every call about it. Making it sends nothing.";
            case COLLECTION -> "The collection `" + n.path() + "`: its list, create and other calls on all of them.";
            default -> "The calls under `" + n.path() + "`.";
        };
    }

    private void node(RustWriter w, Node n) {
        String type = typeName(n);
        w.l("\n" + Names.doc(describe(n), ""));
        w.l("#[derive(Clone, Debug)]\npub struct " + type + " {\n    #[allow(dead_code)]\n    pub(crate) core: rt::Client,\n" + ctxFields(n) + "}\n\n");
        w.l("impl " + type + " {\n");
        StringBuilder from = new StringBuilder("    pub(crate) fn from_ids(core: rt::Client, ids: Vec<String>) -> Self {\n");
        List<String> ids = contextIds(n);
        from.append(ids.isEmpty() ? "        let _ = ids;\n" : "        let mut ids = ids.into_iter();\n");
        from.append("        ").append(type).append(" {\n            core,\n");
        for (String id : ids) {
            from.append("            ").append(Names.snake(id)).append(": ids.next().unwrap_or_default(),\n");
        }
        from.append("        }\n    }\n");
        w.l(from.toString());
        body(w, n);
        w.l("}\n");
        if (n.kind == Kind.SCOPE && n.watch.isPresent()) {
            w.l("\nimpl rt::Follow for " + type + " {\n    type Output = " + waitType(n) + ";\n    type Error = Error;\n    type Progress = crate::operations::Processing;\n\n"
                    + "    fn follow(&self, job: Option<String>) -> rt::Waiting<Self::Output, Error, crate::operations::Processing> {\n        self.follow_job(job)\n    }\n}\n");
        }
    }

    /** Everything on a node: its identifiers, its children, its calls, and watch and wait. */
    private void body(RustWriter w, Node n) {
        Set<String> taken = new HashSet<>();
        n.methods.forEach(m -> taken.add(Names.segment(m.name)));
        if (n.kind == Kind.SCOPE) {
            for (String id : contextIds(n)) {
                String acc = Names.snake(id);
                if (taken.contains(acc) || n.children.containsKey(id)) {
                    continue;
                }
                w.l("\n    /// The `" + id + "` this scope holds.\n    pub fn " + acc + "(&self) -> &str {\n        &self." + acc + "\n    }\n");
            }
            if (n.parent.kind == Kind.COLLECTION && !taken.contains("id") && !contextIds(n).contains("id")) {
                String last = Names.snake(ids(n).get(ids(n).size() - 1));
                w.l("\n    /// The identifier of the thing this scope is.\n    pub fn id(&self) -> &str {\n        &self." + last + "\n    }\n");
            }
        }
        for (Node c : n.children.values()) {
            children(w, n, c);
        }
        for (ScopeTree.Method m : n.methods) {
            method(w, n, m, Optional.empty());
            if (m.estimate.isPresent()) {
                method(w, n, m.estimate.get(), Optional.of(m));
            }
        }
        if (n.kind == Kind.SCOPE && n.watch.isPresent()) {
            watched(w, n, taken);
        }
    }

    private List<String> ids(Node n) {
        return n.identifiers.stream().map(ScopeTree.Identifier::name).toList();
    }

    private void children(RustWriter w, Node n, Node c) {
        String t = typeName(c);
        switch (c.kind) {
            case COLLECTION -> {
                if (!empty(c)) w.l("\n" + Names.doc("The " + Names.segment(c.name) + ": `list`, `create` and the calls on all of them. One of them is `"
                        + Names.segment(c.singular) + "(…)`.", "    "));
                if (!empty(c)) {
                    w.l("    pub fn " + Names.segment(c.name) + "(&self) -> " + t + " {\n        " + t + "::from_ids(self.core.clone(), " + selfIds(n) + ")\n    }\n");
                }
                List<String> params = new ArrayList<>();
                List<String> vals = new ArrayList<>();
                for (String id : contextIds(n)) {
                    if (contextIds(c.scope).contains(id)) {
                        vals.add("self." + Names.snake(id) + ".clone()");
                    }
                }
                for (ScopeTree.Identifier id : c.identifiers) {
                    params.add(Names.snake(id.name()) + ": impl Into<String>");
                    vals.add(Names.snake(id.name()) + ".into()");
                }
                String st = typeName(c.scope);
                boolean folder = c.identifiers.stream().anyMatch(i -> i.name().equals("folderPath"));
                w.l("\n" + Names.doc("One of the " + Names.segment(c.name) + ", by its " + String.join(" and ", c.identifiers.stream().map(ScopeTree.Identifier::name).toList())
                        + (folder ? " (a path as people write it: `\"/hr/leave/\"`)" : "") + ". It sends nothing.", "    "));
                w.l("    pub fn " + Names.segment(c.singular) + "(&self, " + String.join(", ", params) + ") -> " + st + " {\n        " + st
                        + "::from_ids(self.core.clone(), vec![" + String.join(", ", vals) + "])\n    }\n");
            }
            case NAMESPACE -> w.l("\n    /// The calls under `" + c.path() + "`.\n    pub fn " + Names.segment(c.name) + "(&self) -> " + t + " {\n        " + t
                    + "::from_ids(self.core.clone(), " + selfIds(n) + ")\n    }\n");
            case SCOPE -> {
                List<String> vals = new ArrayList<>();
                for (ScopeTree.Identifier id : c.identifiers) {
                    vals.add(id.fixed().map(f -> Names.str(f) + ".to_owned()").orElse("self." + Names.snake(id.name()) + ".clone()"));
                }
                w.l("\n" + Names.doc(c.alias.isPresent() ? "The `" + c.name + "` version: a version scope with its name fixed. It sends nothing."
                        : "`" + c.path() + "`. It sends nothing.", "    "));
                w.l("    pub fn " + Names.segment(c.name) + "(&self) -> " + t + " {\n        " + t + "::from_ids(self.core.clone(), vec!["
                        + String.join(", ", vals) + "])\n    }\n");
            }
            default -> throw new CodegenException(c.path() + ": unexpected node");
        }
    }

    private void method(RustWriter w, Node n, ScopeTree.Method m, Optional<ScopeTree.Method> job) {
        OperationInfo op = g.info(m.operation.getId());
        ServiceGenerator.Placed placed = new ServiceGenerator.Placed(n, m, job);
        boolean file = job.isPresent() ? g.takesFile(placed) : g.topLevelTarget(op).isPresent();
        String name = job.map(j -> "estimate_" + Names.segment(j.name)).orElse(Names.segment(m.name));
        List<String> params = new ArrayList<>();
        StringBuilder body = new StringBuilder("        let mut input = " + op.inputType() + "::default();\n");
        for (String lead : m.leading) {
            params.add(Names.snake(lead) + ": impl Into<String>");
            body.append("        let ").append(Names.snake(lead)).append(": String = ").append(Names.snake(lead)).append(".into();\n");
        }
        for (ScopeTree.Fill f : m.fills) {
            OperationInfo.Param p = op.param(f.member()).orElseThrow(() -> new CodegenException(op.name + " has no member " + f.member()));
            String src = m.leading.contains(f.identifier()) ? Names.snake(f.identifier()) + ".clone()" : "self." + Names.snake(f.identifier()) + ".clone()";
            if (f.trimSlashes()) {
                src = "rt::trim_slashes(&" + src.replace(".clone()", "") + ")";
            }
            body.append("        input.").append(p.field()).append(" = ").append(p.member().isRequired() ? src : "Some(" + src + ")").append(";\n");
        }
        if (file) {
            params.add("file: impl Into<rt::UploadFile>");
            if (job.isEmpty()) {
                body.append("        input.").append(g.topLevelTarget(op).get().fileField()).append(" = Some(file.into());\n");
            }
        }
        for (OperationInfo.Param p : g.positional(op, m, file || g.topLevelTarget(op).isPresent())) {
            String v = p.field();
            params.add(v + ": " + g.paramType(p.member()));
            body.append("        input.").append(p.field()).append(" = ").append(g.convert(p.member(), v)).append(";\n");
        }
        String ctx = m.leading.isEmpty() ? selfIds(n) : "vec![" + String.join(", ", m.leading.stream().map(l -> Names.snake(l) + ".clone()").toList()) + "]";
        String req = g.requestType(op) + "::new(self.core.clone(), input, " + ctx + ")" + (job.isPresent() && file ? ".with_file(file.into())" : "");
        String extra = "";
        if (job.isPresent()) {
            extra = "The estimate for `" + Names.segment(job.get().name) + "`, with the same arguments" + (file ? ": only the file's description is sent, and nothing is uploaded" : "")
                    + ". It does no work.";
        } else if (m.longRunning.isPresent()) {
            extra = "It starts work: `send().await` returns " + (m.creates.isPresent() ? "the new thing's scope" : "the response") + ", and its `wait()` "
                    + "waits until the work has ended (PROTOCOL.md 16).";
        } else if (m.creates.isPresent()) {
            extra = "It returns the new thing's scope, with the response as `output`.";
        }
        if (file && job.isEmpty()) {
            extra += (extra.isEmpty() ? "" : " ") + "The file (a path, `UploadFile`, or a name with bytes) is uploaded first, as `core().uploads().send` does.";
        }
        w.l("\n" + g.methodDoc(op, extra, "    "));
        w.l("    pub fn " + name + "(&self" + (params.isEmpty() ? "" : ", " + String.join(", ", params)) + ") -> " + g.requestType(op) + " {\n" + body
                + "        " + req + "\n    }\n");
    }

    /** watch(), wait(), planned() and the follows a started call's wait uses. */
    private void watched(RustWriter w, Node n, Set<String> taken) {
        OperationInfo watch = watchOp(n);
        String watchReq = g.requestType(watch);
        if (!taken.contains("watch")) {
            StringBuilder b = new StringBuilder("        let mut input = " + watch.inputType() + "::default();\n");
            for (String id : contextIds(n)) {
                watch.param(id).ifPresent(p -> b.append("        input.").append(p.field()).append(" = ")
                        .append(p.member().isRequired() ? "self." + Names.snake(id) + ".clone()" : "Some(self." + Names.snake(id) + ".clone())").append(";\n"));
            }
            n.watch.get().filter().ifPresent(f -> {
                OperationInfo.Param p = watch.param(f).orElseThrow(() -> new CodegenException(watch.name + " has no filter " + f));
                String last = "self." + Names.snake(contextIds(n).get(contextIds(n).size() - 1)) + ".clone()";
                b.append("        input.").append(p.field()).append(" = ").append(p.member().isRequired() ? last : "Some(" + last + ")").append(";\n");
            });
            w.l("\n" + Names.doc("Watches this thing (PROTOCOL.md 16): " + watch.name + " with its identifier as the filter. The first event of "
                    + "every connection is a `snapshot` of how it stands, then one event per change; a dropped connection is reopened with no "
                    + "cursor and starts with a snapshot again.", "    "));
            String made = watchReq + "::new(self.core.clone(), input, vec![])";
            if (plans(n)) {
                // A batch's watch reads the batch again once its deadline has passed (PROTOCOL.md 16): with its get, put
                // into a snapshot (in place of the one given, or with no jobs and no progress), and its typed deadline.
                String union = "crate::types::" + events(n).getId().getName();
                String snapshot = "crate::types::" + events(n).getMember("snapshot").orElseThrow().getTarget().getName();
                String key = Names.snake(thingKey(n));
                b.append("        let this = self.clone();\n");
                made += "\n            .reread_at_deadline(rt::stream::Reread::new(\n"
                        + "                move |base| {\n"
                        + "                    let get = this.get();\n"
                        + "                    Box::pin(async move {\n"
                        + "                        let mut snapshot = match base {\n"
                        // The server's JSON showed the batch as it no longer stands.
                        + "                            Some(" + union + "::Snapshot(s)) => " + snapshot + " { raw: Default::default(), ..s },\n"
                        + "                            _ => " + snapshot + "::default(),\n"
                        + "                        };\n"
                        + "                        snapshot." + key + " = Some(get.send().await?);\n"
                        + "                        Ok(" + union + "::Snapshot(snapshot))\n"
                        + "                    })\n"
                        + "                },\n"
                        + "                |ev| match ev {\n"
                        + "                    " + union + "::Snapshot(s) => s." + key + ".as_ref().map(|b| rt::stream::batch_deadline(b.status.as_str(), b.uploads_expire_at)),\n"
                        + "                    _ => None,\n"
                        + "                },\n"
                        + "            ))";
            }
            w.l("    pub fn watch(&self) -> " + watchReq + " {\n" + b + "        " + made + "\n    }\n");
        }
        String wt = waitType(n);
        boolean batch = plans(n);
        w.l("\n" + Names.doc("Waits until no job runs on this thing" + (batch ? " (the batch has ended)" : "") + ", and returns it as `get` would "
                + "(PROTOCOL.md 16). A job that ended `completed_with_failures` returns, with the partial failures on the thing; one that "
                + "failed is the typed error for its code, and a cancelled one the code `CANCELLED`. Set a time limit with `.timeout(…)`: past it, the wait fails with [`Error::Timeout`]. `.on_progress(|p| …)` is called with "
                + "the thing's processing (" + (isDocument(n) ? "its `DocumentProcessing`" : "its running job") + "): the snapshot's first, then each change's.", "    "));
        w.l("    pub fn wait(&self) -> rt::Waiting<" + wt + ", Error, crate::operations::Processing> {\n        self.follow_job(None)\n    }\n");
        if (batch) {
            w.l("\n    /// Waits until the batch is planned, or past it, and returns it (PROTOCOL.md 16).\n"
                    + "    pub fn planned(&self) -> rt::Waiting<" + wt + ", Error, crate::operations::Processing> {\n        self.follow_until(None, rt::watch::Until::Planned)\n    }\n");
        }
        w.l("\n    /// Waits for the job a call started (or, with `None`, until no job runs), as `wait` does.\n"
                + "    pub(crate) fn follow_job(&self, job: Option<String>) -> rt::Waiting<" + wt + ", Error, crate::operations::Processing> {\n"
                + "        self.follow_until(job, rt::watch::Until::" + (batch ? "Ended" : "Idle") + ")\n    }\n");
        w.l("\n    /// A cancel's own wait (PROTOCOL.md 16): as `follow_job`, but the work ending cancelled returns the thing, not\n"
                + "    /// `CANCELLED`.\n    #[allow(dead_code)]\n"
                + "    pub(crate) fn follow_cancel(&self, job: Option<String>) -> rt::Waiting<" + wt + ", Error, crate::operations::Processing> {\n"
                + "        self.follow_until(job, rt::watch::Until::Cancelling(Box::new(rt::watch::Until::" + (batch ? "Ended" : "Idle") + ")))\n    }\n");
        String last = "this." + Names.snake(contextIds(n).get(contextIds(n).size() - 1)) + ".clone()";
        String rules = "rt::watch::Rules {\n                thing: " + Names.str(thingKey(n)) + ",\n                gone_when: "
                + goneWhen(n).map(k -> "Some((" + Names.str(k) + ", " + last + "))").orElse("None")
                + ",\n                job,\n                until,\n                codes: crate::error::ERROR_CODES,\n"
                + "                observe: progress.map(|f| crate::operations::Processing::observer(f, " + Names.str(isDocument(n) ? "document" : "job") + ", " + last + ")),\n            }";
        String ready = getMethod(n).isPresent()
                ? "this.get().options(wopts.call_options()).send().await"
                : "serde_json::from_value(v).map_err(|e| Error::from(rt::Error::sdk(\"DECODE_FAILED\", \"The watched thing could not be decoded\", Some(Box::new(e)))))";
        w.l("\n    fn follow_until(&self, job: Option<String>, until: rt::watch::Until) -> rt::Waiting<" + wt + ", Error, crate::operations::Processing> {\n"
                + "        let this = self.clone();\n        rt::Waiting::new(move |wopts, progress| {\n            Box::pin(async move {\n"
                + "            let watch = this.watch();\n            let rules = " + rules + ";\n"
                + "            match rt::watch::follow(move |o| watch.options(o).send(), rules, wopts.clone(), Error::is_not_found).await? {\n"
                + "                rt::watch::Outcome::Ready(v) => {\n                    let _ = &v;\n                    " + ready + "\n                }\n"
                + "                rt::watch::Outcome::Gone => Err(Error::from(rt::Error::sdk(\"NOT_FOUND\", \"The thing is gone\", None))),\n"
                + "            }\n            })\n        })\n    }\n");
        if (goneTargets.contains(n)) {
            w.l("\n    /// Waits until a delete has ended: the thing is gone, or the job deleting it has ended.\n"
                    + "    pub(crate) fn follow_gone(&self, job: Option<String>) -> rt::Waiting<(), Error, crate::operations::Processing> {\n"
                    + "        let this = self.clone();\n        rt::Waiting::new(move |wopts, progress| {\n            Box::pin(async move {\n"
                    + "            let watch = this.watch();\n            let until = rt::watch::Until::Gone;\n            let rules = " + rules + ";\n"
                    + "            rt::watch::follow(move |o| watch.options(o).send(), rules, wopts, Error::is_not_found).await?;\n"
                    + "            Ok(())\n            })\n        })\n    }\n");
        }
    }

    // ------------------------------------------------------------------ the client

    private void client(RustWriter w) {
        Node root = g.tree.root;
        w.l(Names.doc("The " + g.title() + " client. Create one with [`Client::new`] or [`Client::builder`] and share it: clones are cheap "
                + "and share the token cache. It is the top of the tree of scopes: `client.knowledge_bases().list()`, "
                + "`client.knowledge_base(id).documents().create(file)`, `client.agent(id).draft().publish()`.", ""));
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
        body(w, root);
        w.l("}\n\n");
        w.l("/// Builds a [`Client`].\npub struct ClientBuilder(rt::ClientBuilder);\n\nimpl ClientBuilder {\n");
        w.l("    /// Sends requests (and token requests) to `endpoint` instead of `https://<workspace>/api`. It never changes the token audience.\n"
                + "    pub fn endpoint(self, endpoint: impl Into<String>) -> Self {\n        ClientBuilder(self.0.endpoint(endpoint))\n    }\n\n");
        w.l("    /// Replaces the HTTP client. Build it with `redirect(reqwest::redirect::Policy::none())`: a download address is a 302\n    /// the SDK returns, not follows.\n    pub fn http_client(self, client: rt::reqwest::Client) -> Self {\n        ClientBuilder(self.0.http_client(client))\n    }\n\n");
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
        w.l("    /// Where a one-shot reader past 8 MiB is spooled while it is hashed: a file only its owner can read, deleted\n"
                + "    /// when the call ends. Default: the system's temporary directory.\n"
                + "    pub fn spool_dir(self, dir: impl Into<std::path::PathBuf>) -> Self {\n        ClientBuilder(self.0.spool_dir(dir))\n    }\n\n");
        w.l("    /// Builds the client.\n    pub fn build(self) -> Result<Client, Error> {\n        Ok(Client { core: self.0.build()? })\n    }\n}\n");
    }

    // ------------------------------------------------------------------ core.uploads.send (PROTOCOL.md 10, 14)

    private void uploads(RustWriter w) {
        OperationInfo op = g.presigned();
        for (String m : List.of("fileName", "contentType", "byteSize", "sha256")) {
            op.param(m).orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs input member " + m));
        }
        for (String m : List.of("id", "uploadUrl", "uploadMethod", "requiredHeaders")) {
            op.output.getMember(m).filter(MemberShape::isRequired)
                    .orElseThrow(() -> new CodegenException(op.op.getId() + ": @presignedUpload needs required output member " + m));
        }
        ServiceGenerator.Placed at = g.placements.get(op.op.getId()).get(0);
        Node n = at.node();
        if (n.methods.stream().anyMatch(m -> m.name.equals("send") || m.name.equals("sendFor"))) {
            throw new CodegenException(n.path() + " already has send; the upload helper needs the name");
        }
        String result = ty(g.resultType(op));
        Optional<OperationInfo.Param> purpose = op.param("purpose");
        String purposeType = purpose.map(p -> ty(g.ctx.types().base(g.target(p.member())))).orElse("()");
        w.l("\n/// Uploads a file: hashes it, reserves the upload with " + op.name + " (with `purpose`), then sends the bytes to the\n"
                + "/// upload URL with exactly the required headers (PROTOCOL.md 14).\n"
                + "pub(crate) async fn send_upload(\n    core: &rt::Client,\n    file: rt::UploadFile,\n    purpose: Option<" + purposeType + ">,\n"
                + "    opts: rt::CallOptions,\n) -> Result<" + result + ", Error> {\n"
                + "    let prepared = core.prepare_file(&file, &opts).await.map_err(Error::from)?;\n"
                + "    let input = " + op.inputType() + " {\n        file_name: prepared.name().to_owned(),\n        content_type: prepared.content_type().to_owned(),\n"
                + "        byte_size: prepared.size() as i64,\n        sha256: prepared.sha256().to_owned(),\n"
                + (purpose.isPresent() ? "        purpose,\n" : "") + "        ..Default::default()\n    };\n"
                + (purpose.isEmpty() ? "    let _ = purpose;\n" : "")
                + "    let up = " + g.requestType(op) + "::new(core.clone(), input, vec![]).options(opts.clone()).send().await?;\n"
                + "    core.put_presigned(&up.upload_method, &up.upload_url, &up.required_headers, &prepared, &opts)\n"
                + "        .await\n        .map_err(Error::from)?;\n    Ok(up)\n}\n\n");
        String type = typeName(n);
        w.l("impl " + type + " {\n");
        w.l(Names.doc("Uploads a file (PROTOCOL.md 14): it hashes the file with streaming reads (spooling a one-shot reader, to a "
                + "temporary file past 8 MiB), reserves the upload, then sends the bytes to the upload URL with exactly the required "
                + "headers (no Caitlyn credentials go there), retried as a retry-safe call. A file over 2 GB fails with the code "
                + "`FILE_TOO_LARGE` and a path that changed after it was hashed with `FILE_CHANGED`, before anything more is sent; bytes the "
                + "upload URL does not take give `UPLOAD_PUT_FAILED`. It returns the upload: pass its `id` to the call that uses it.", "    "));
        w.l("    pub fn send(&self, file: impl Into<rt::UploadFile>) -> rt::Call<" + result + ", Error> {\n"
                + "        let core = self.core.clone();\n        let file = file.into();\n"
                + "        rt::Call::new(move |opts| Box::pin(async move { send_upload(&core, file, None, opts).await }))\n    }\n");
        if (purpose.isPresent()) {
            w.l("\n" + Names.doc("As [`send`](Self::send), reserving the upload with `purpose`, for an upload whose use decides whether it "
                    + "is accepted (an agent's avatar picture, a conversation's attachment).", "    "));
            w.l("    pub fn send_for(&self, file: impl Into<rt::UploadFile>, purpose: " + purposeType + ") -> rt::Call<" + result + ", Error> {\n"
                    + "        let core = self.core.clone();\n        let file = file.into();\n"
                    + "        rt::Call::new(move |opts| Box::pin(async move { send_upload(&core, file, Some(purpose), opts).await }))\n    }\n");
        }
        w.l("}\n");
    }

    // ------------------------------------------------------------------ kb.ingestion().sync (PROTOCOL.md 15)

    private void sync(RustWriter w) {
        Optional<OperationInfo> create = g.byName("CreateIngestionBatch");
        Optional<OperationInfo> get = g.byName("GetIngestionBatch");
        Optional<OperationInfo> list = g.byName("ListIngestionBatchItems");
        Optional<OperationInfo> resolve = g.byName("UpdateIngestionBatchItem");
        Optional<OperationInfo> estimate = g.byName("EstimateIngestion");
        if (create.isEmpty()) {
            return;
        }
        if (get.isEmpty() || list.isEmpty() || resolve.isEmpty() || estimate.isEmpty()) {
            throw new CodegenException("ingestion.sync needs GetIngestionBatch, ListIngestionBatchItems, UpdateIngestionBatchItem and EstimateIngestion");
        }
        Node batches = g.placements.get(create.get().op.getId()).get(0).node();
        Node holder = batches.parent;
        if (holder.kind != Kind.NAMESPACE) {
            throw new CodegenException("ingestion.sync goes on the namespace above the batches, " + holder.path() + " is a " + holder.kind);
        }
        String policy = "crate::types::" + g.ctx.types().base(g.target(create.get().param("policy").orElseThrow().member()));
        String batch = "crate::types::" + g.resultType(get.get());
        var pi = list.get().pagination.orElseThrow();
        String item = "crate::types::" + g.ctx.types().base(g.model.expectShape(((software.amazon.smithy.model.shapes.ListShape) g.target(pi.getItemsMemberPath().get(0)))
                .getMember().getTarget()));
        String resolution = "crate::types::" + g.ctx.types().base(g.target(resolve.get().param("resolution").orElseThrow().member()));
        String est = "crate::types::" + g.resultType(estimate.get());
        String kbField = Names.snake(contextIds(holder).get(0));
        w.l("\n/// What `kb.ingestion().sync(…)` keeps in step, and how: a directory (`\"./policies\"`, or `SyncInput::dir`) or\n"
                + "/// `SyncInput::items(…)`, then its options (`folder`, `policy`, `external_id`, `remove_missing`, `confirm`, `resolver`,\n"
                + "/// `on_progress`, `on_item`, …).\n");
        w.l("pub type SyncInput = rt::sync::SyncInput<" + policy + ", " + batch + ", " + item + ", " + resolution + ", " + est + ">;\n\n");
        w.l("/// What `kb.ingestion().sync(…)` returns: the finished batch and every item.\npub type SyncReport = rt::sync::SyncReport<" + batch + ", " + item + ">;\n\n");
        w.l("/// What `kb.ingestion().estimate_sync(…)` returns, and `confirm` is given: the planned batch, its items and its estimate.\n"
                + "pub type SyncPlan = rt::sync::SyncPlan<" + batch + ", " + item + ", " + est + ">;\n\n");
        w.l("/// One progress report of `kb.ingestion().sync(…)`.\npub type IngestionProgress = rt::sync::IngestionProgress<" + item + ">;\n\n");
        w.l("pub use rt::sync::{LocalFile, SyncItem, SyncPhase};\n\n");
        w.l("impl " + typeName(holder) + " {\n");
        w.l(Names.doc("Keeps the knowledge base in step with a folder of files, or a list of items, through one ingestion batch "
                + "(PROTOCOL.md 15). Files are keyed by their relative path and go to `/` unless `folder` says otherwise. It hashes each "
                + "file, creates the batch (`start: manual`, 10,000 items a call), waits until it is planned and prices it, asks `confirm` "
                + "and the `resolver` when they are set (an item the policy left unresolved with no resolver fails with "
                + "`INGESTION_BATCH_UNRESOLVED`, leaving the batch planned), starts it, sends each file awaiting upload under the batch's "
                + "upload policy (6 at once by default), reports the uploads 100 at a time, waits until the batch has ended and returns "
                + "every item. A file whose upload fails is reported with `UPLOAD_FAILED` and the rest carry on. Cancelling (`cancel_on`) "
                + "stops new uploads, aborts those in flight and fails with [`Error::Cancelled`]; with `cancel_ingestion(true)` it also "
                + "cancels the batch.", "    "));
        w.l("    pub fn sync(&self, input: impl Into<SyncInput>) -> rt::Call<SyncReport, Error> {\n"
                + "        let core = self.core.clone();\n        let kb = self." + kbField + ".clone();\n        let input = input.into();\n"
                + "        rt::Call::new(move |opts| Box::pin(async move { rt::sync::run(core, kb, input, crate::error::ERROR_CODES, opts).await }))\n    }\n\n");
        w.l(Names.doc("What `sync` would do and cost, before anything is uploaded: it hashes the files, creates the batch, waits until "
                + "it is planned and prices the items that need bytes (PROTOCOL.md 15, steps 1 to 3). The batch is left planned.", "    "));
        w.l("    pub fn estimate_sync(&self, input: impl Into<SyncInput>) -> rt::Call<SyncPlan, Error> {\n"
                + "        let core = self.core.clone();\n        let kb = self." + kbField + ".clone();\n        let input = input.into();\n"
                + "        rt::Call::new(move |opts| Box::pin(async move { rt::sync::estimate(core, kb, input, crate::error::ERROR_CODES, opts).await }))\n    }\n}\n");
        batchUpload(w, g.placements.get(get.get().op.getId()).get(0).node(), batch, item, est);
    }

    /** `batch.upload(files)` and `batch.estimate_upload()` on the batch's scope (PROTOCOL.md 15). */
    private void batchUpload(RustWriter w, Node scope, String batch, String item, String est) {
        List<String> ids = contextIds(scope);
        if (ids.size() != 2 || scope.watch.isEmpty()) {
            throw new CodegenException(scope.path() + ": batch.upload needs a watched scope with a knowledge base and a batch identifier");
        }
        String kb = "self." + Names.snake(ids.get(0)) + ".clone()";
        String id = "self." + Names.snake(ids.get(1)) + ".clone()";
        String type = typeName(scope);
        String stream = g.watchStream(scope);
        w.l("\n/// The files `batch.upload(files)` and `batch.estimate_upload().files(…)` take: by item path\n"
                + "/// (`BatchFiles::by_path([(\"/hr/leave.pdf\", file)])`, or a `HashMap`, a `BTreeMap`, an array or a `Vec` of pairs), or\n"
                + "/// `BatchFiles::with(|item| …)`, a file for each item as it is needed.\n");
        w.l("pub type BatchFiles = rt::sync::BatchFiles<" + item + ">;\n\n");
        w.l("/// What `batch.upload(files)` gives: `batch`, the items it dealt with, `not_given` and `unmatched`.\n"
                + "pub type BatchUpload = rt::sync::BatchUpload<" + batch + ", " + item + ">;\n\n");
        w.l("/// `batch.upload(files)`, with its options; await it for the handle, or `.wait()` for the finished batch.\n"
                + "pub type BatchUploadRequest = rt::batch::UploadRequest<" + batch + ", " + item + ", " + batch + ", " + stream
                + ", Error, crate::operations::Processing>;\n\n");
        w.l("/// `batch.estimate_upload()`, with its optional files; await it for the estimate.\n"
                + "pub type EstimateUploadRequest = rt::batch::EstimateUploadRequest<" + item + ", " + est + ", Error>;\n\n");
        w.l("impl " + type + " {\n");
        w.l(Names.doc("Sends the batch's files (PROTOCOL.md 15) with the steps `ingestion().sync(…)` uses: the items awaiting upload "
                + "that `files` has a file for, 6 at a time, under an upload policy renewed as it runs low, reported to "
                + "CompleteIngestionBatchUploads 100 at a time. Files are not hashed: the form carries each item's checksum, and a file "
                + "whose size is not the item's fails it with `FILE_CHANGED` before anything is sent. An upload that still fails fails "
                + "its item only (`UPLOAD_FAILED`). An awaiting item with no file is left awaiting (`not_given`), and a given path no "
                + "awaiting item has is `unmatched`. The batch must have started: a draft, or a planned batch waiting for "
                + "`start()`, fails with `INGESTION_BATCH_NOT_STARTED` (status 0) with nothing sent; a `when_planned` batch still "
                + "planning is followed until it runs. Cancelling aborts the uploads and leaves the batch as it is. Await it for the "
                + "handle (`result()` is the [`BatchUpload`]), or `.wait()` for the [`" + batch.replace("crate::types::", "") + "`] once it "
                + "has ended.", "    "));
        w.l("    pub fn upload(&self, files: impl Into<BatchFiles>) -> BatchUploadRequest {\n"
                + "        let (waiter, watcher) = (self.clone(), self.clone());\n"
                + "        rt::batch::UploadRequest::new(\n            self.core.clone(),\n            " + kb + ",\n            " + id + ",\n"
                + "            files.into(),\n            crate::error::ERROR_CODES,\n            move || waiter.wait(),\n"
                + "            move || watcher.watch().send(),\n        )\n    }\n\n");
        w.l(Names.doc("What uploading the batch's files would take and cost, before it is started (PROTOCOL.md 15): one "
                + "EstimateIngestion (10,000 documents a call, added together) for the items that need bytes (`add`, `new_version`, "
                + "`overwrite`), each described by name, content type and size: from its file with `.files(…)`, with the hints the file "
                + "carries, or from the item. Nothing is hashed or read beyond a file's size. A draft batch fails with "
                + "`INGESTION_BATCH_NOT_PLANNED` (status 0) with nothing sent; a planning one is waited on until planned. With nothing "
                + "to price, the estimate is empty and no call is sent.", "    "));
        w.l("    pub fn estimate_upload(&self) -> EstimateUploadRequest {\n"
                + "        rt::batch::EstimateUploadRequest::new(self.core.clone(), " + kb + ", " + id + ", crate::error::ERROR_CODES)\n    }\n}\n");
    }
}
