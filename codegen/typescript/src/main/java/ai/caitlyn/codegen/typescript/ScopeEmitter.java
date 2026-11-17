package ai.caitlyn.codegen.typescript;

import ai.caitlyn.codegen.model.ScopeTree;
import ai.caitlyn.codegen.model.ScopeTree.Kind;
import ai.caitlyn.codegen.model.ScopeTree.Method;
import ai.caitlyn.codegen.model.ScopeTree.Node;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.EnumShape;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.EnumValueTrait;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.JsonNameTrait;
import software.amazon.smithy.model.traits.RequiredTrait;
import software.amazon.smithy.typescript.codegen.TypeScriptCodegenContext;

/**
 * client.ts: the client as scopes (PROTOCOL.md 10), from model-support's ScopeTree, with watch() and wait() on every
 * scope the model follows (PROTOCOL.md 16).
 *
 * <ul>
 *   <li>A collection is a function with properties: {@code caitlyn.knowledgeBases(id)} makes a scope, and
 *       {@code caitlyn.knowledgeBases.list()} is its method. A singleton or named scope ({@code agent.draft}) and a
 *       plain namespace ({@code kb.ingestion}) are properties. {@code caitlyn.core} holds the building blocks, which
 *       take their identifiers as leading arguments.</li>
 *   <li>Each method fills the identifiers its scope holds and calls the operation's standalone function
 *       (operations.ts). A folder path in a request path is sent without its first and last {@code /}.</li>
 *   <li>Arguments: an upload target's file first; else, when exactly one required member is left (and at most two
 *       optional ones beside it), that member first ({@code kb.fields.fillIn(keys)},
 *       {@code conversation.send(message, {context})}); then an object of the other members; then the call options
 *       ({@code ifMatch}, {@code idempotencyKey}, {@code signal}).</li>
 *   <li>{@code create} returns the new thing's scope with the response's fields. A call that starts work
 *       ({@code @longRunning}) returns a WorkPromise: awaiting it gives the response, {@code .wait()} the thing once
 *       the work is done. An estimate is {@code job.estimate(sameArguments)}.</li>
 * </ul>
 */
final class ScopeEmitter {

    private static final ShapeId SSE_EVENTS = ShapeId.from("ai.caitlyn.traits#sseEvents");

    private final FacadeGenerator g;
    private final Model model;
    private final ServiceShape service;
    private final ScopeTree tree;
    private final Map<Node, String> names = new IdentityHashMap<>();
    private final Set<String> modelTypes = new TreeSet<>();
    private final Set<String> eventTypes = new TreeSet<>();
    private final StringBuilder types = new StringBuilder();
    private final StringBuilder impl = new StringBuilder();

    ScopeEmitter(FacadeGenerator g, Model model, ServiceShape service, TypeScriptCodegenContext context) {
        this.g = g;
        this.model = model;
        this.service = service;
        this.tree = ScopeTree.of(model, service);
    }

    // ------------------------------------------------------------------------------------------------ names

    private static String pascal(String s) {
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    /** The words that name a node: each scope by its collection's singular, everything else by its own name. */
    private static List<String> words(Node n) {
        if (n.parent == null) return new ArrayList<>();
        if (n.kind == Kind.SCOPE && n.parent.kind == Kind.COLLECTION) {
            List<String> w = words(n.parent.parent);
            w.add(n.parent.singular);
            return w;
        }
        List<String> w = words(n.parent);
        w.add(n.name);
        return w;
    }

    private String nameOf(Node n) {
        return names.computeIfAbsent(n, x -> {
            String base = words(x).stream().map(ScopeEmitter::pascal).collect(Collectors.joining());
            String name = base + switch (x.kind) {
                case COLLECTION -> "Collection";
                case SCOPE -> "Scope";
                case NAMESPACE -> "Namespace";
                case ROOT -> "";
            };
            // A model shape of the same name (the ConversationScope enum) keeps its name; the scope takes the service's.
            boolean taken = model.getShapeIds().stream().anyMatch(id -> id.getName().equals(name));
            return taken ? service.getId().getName() + name : name;
        });
    }

    // ------------------------------------------------------------------------------------------------ the file

    String clientFile() {
        Set<String> seen = new TreeSet<>();
        for (Node n : tree.root.walk()) {
            if (n == tree.root) continue;
            if (!seen.add(nameOf(n))) throw new CodegenException("Two scope tree nodes are both named " + nameOf(n));
            if (model.getShapeIds().stream().anyMatch(id -> id.getName().equals(nameOf(n)))) {
                throw new CodegenException("The scope tree's " + nameOf(n) + " has the name of a model shape");
            }
        }
        for (Node n : tree.root.walk()) {
            if (n == tree.root) continue;
            if (n.kind == Kind.COLLECTION) collection(n);
            else object(n);
        }
        boolean sync = g.hasSyncOperations();
        StringBuilder out = new StringBuilder(FacadeGenerator.HEADER)
            .append("import { CaitlynClient } from \"../CaitlynClient\";\n")
            .append("import { clientConfig, createAuth, getCaitlynAuthPlugin, getCaitlynConnectionErrorPlugin, getCaitlynTelemetryPlugin, WorkPromise, waitFor, waitForJob, readers, trimFolder, withFields, eager, describeFile")
            .append(sync ? ", thingOf, batchUpload, estimateUpload, type BatchFiles, type BatchUpload, type BatchUploadOptions, sync as runSync, estimateSync, type SyncDeps, type SyncItemInput, type SyncOptions, type SyncPlan, type SyncReport" : "")
            .append(", type AuthSession, type CaitlynOptions, type CallOptions, type FileInput, type ReadersShorthand, type UploadDescription, type ScopeWatchAccessor, type SseStream, type WaitOptions, type WaitSpec, type WithRaw } from \"@caitlyn-ai/sdk-core\";\n")
            .append("import type { MetadataBearer as __MetadataBearer } from \"@caitlyn-ai/sdk-core\";\n")
            .append("import { CaitlynConnectionError } from \"./connection\";\n")
            .append("import { toError, jobError").append(sync ? ", storage" : "").append(" } from \"./problems\";\n")
            .append("import * as ops from \"./operations\";\n");
        if (sync) out.append("import type { IngestionBatch as __SyncReportBatch, IngestionBatchItem as __SyncReportItem } from \"../models/models_0\";\n");
        if (sync) {
            for (String op : FacadeGenerator.SYNC_OPERATIONS) out.append("import { ").append(op).append("Command } from \"../commands/").append(op).append("Command\";\n");
        }
        if (!modelTypes.isEmpty()) out.append(g.typeImports(modelTypes));
        if (!eventTypes.isEmpty()) out.append("import type { ").append(String.join(", ", eventTypes)).append(" } from \"./events\";\n");
        out.append("\n/** The identifiers a scope holds, by name. */\ntype Ids = Record<string, string>;\n")
            .append("/** A response, as every call returns it. */\ntype Out<T> = WithRaw<T & __MetadataBearer>;\n")
            .append("/** What a create returns: the new thing's scope, with the thing's fields (KnowledgeBaseScope & KnowledgeBase). */\n")
            .append("export type Created<S, T> = S & Omit<T, keyof S>;\n\n")
            .append("/** Creates the client the standalone operation functions take as their first argument. */\n")
            .append("export function createCaitlynClient(options: CaitlynOptions, auth: AuthSession = createAuth(options)): CaitlynClient {\n")
            .append("  const client = new CaitlynClient(clientConfig(options, auth));\n")
            .append("  client.middlewareStack.use(getCaitlynAuthPlugin(auth));\n")
            .append("  if (options.telemetry?.enabled !== false) client.middlewareStack.use(getCaitlynTelemetryPlugin(options.telemetry?.tracerProvider));\n")
            .append("  client.middlewareStack.use(getCaitlynConnectionErrorPlugin((operation, cause) => new CaitlynConnectionError(operation, cause)));\n")
            .append("  return client;\n}\n\n");
        if (sync) out.append(syncDeps());
        out.append(types).append(impl);
        out.append(rootClass());
        return out.toString();
    }

    // ------------------------------------------------------------------------------------------------ nodes

    /** The identifiers a node's scope holds (the nearest scope at or above it). */
    private static List<ScopeTree.Identifier> scopeIds(Node n) {
        Node cur = n;
        while (cur != null && cur.kind != Kind.SCOPE) cur = cur.parent;
        return cur == null ? List.of() : cur.identifiers;
    }

    /** A scope's own identifier: the last one it holds. */
    private static Optional<String> ownId(Node scope) {
        return scope.identifiers.isEmpty() ? Optional.empty() : Optional.of(scope.identifiers.get(scope.identifiers.size() - 1).name());
    }

    /** The expression a child node is made with: a collection or namespace from the same identifiers; a named scope adds its fixed value. */
    private String childExpr(Node child, String ids) {
        if (child.kind == Kind.SCOPE && child.alias.isPresent()) {
            String fixed = child.identifiers.stream().filter(i -> i.fixed().isPresent())
                .map(i -> i.name() + ": " + str(i.fixed().get())).collect(Collectors.joining(", "));
            return "make" + nameOf(child) + "(c, { ..." + ids + ", " + fixed + " })";
        }
        return "make" + nameOf(child) + "(c, " + ids + ")";
    }

    /** A scope, singleton, named scope or namespace: an interface and a function that makes it. */
    private void object(Node n) {
        String type = nameOf(n);
        types.append("/** `").append(n.path()).append("`").append(n.kind == Kind.NAMESPACE ? "" : ": a scope; making it sends nothing").append(". */\n")
            .append("export interface ").append(type).append(" {\n");
        impl.append("function make").append(type).append("(c: CaitlynClient, ids: Ids): ").append(type).append(" {\n  return {\n");
        if (n.kind == Kind.SCOPE) {
            for (ScopeTree.Identifier id : n.identifiers) {
                types.append("  readonly ").append(id.name()).append(": ").append(id.fixed().map(this::str).orElse("string")).append(";\n");
                impl.append("    ").append(id.name()).append(": ids.").append(id.name()).append(id.fixed().map(f -> " as " + str(f)).orElse("")).append(",\n");
            }
        }
        members(n, "ids");
        types.append("}\n\n");
        impl.append("  };\n}\n\n");
    }

    /** A collection: callable with its scope's own identifiers, with the collection's methods as properties. */
    private void collection(Node n) {
        String type = nameOf(n);
        Node scope = n.scope;
        String params = n.identifiers.stream().map(i -> i.name() + ": string").collect(Collectors.joining(", "));
        String args = n.identifiers.stream().map(ScopeTree.Identifier::name).collect(Collectors.joining(", "));
        types.append("/** `").append(n.path()).append("`: call it with ").append(n.identifiers.size() == 1 ? "an identifier" : "the identifiers")
            .append(" for one thing's scope; its methods act on the collection. */\n")
            .append("export interface ").append(type).append(" {\n")
            .append("  (").append(params).append("): ").append(nameOf(scope)).append(";\n");
        impl.append("function make").append(type).append("(c: CaitlynClient, ids: Ids): ").append(type).append(" {\n")
            .append("  return Object.assign((").append(params).append(") => make").append(nameOf(scope)).append("(c, { ...ids, ").append(args).append(" }), {\n");
        members(n, "ids");
        types.append("}\n\n");
        impl.append("  });\n}\n\n");
    }

    /** A node's methods, the scope's watch(), wait() and planned(), and its children. */
    private void members(Node n, String ids) {
        for (Method m : n.methods) method(n, m, ids);
        // @presignedUpload: core.uploads.send(file), beside the reservation (PROTOCOL.md 10).
        if (n.methods.stream().anyMatch(m -> m.operation.hasTrait(ShapeId.from("ai.caitlyn.traits#presignedUpload")))) {
            types.append("  /** Sends a file (PROTOCOL.md 14): hashes it, reserves an upload, PUTs the bytes, and returns the upload, whose `id` an operation that takes an upload uses. */\n")
                .append("  send(file: FileInput, input?: Parameters<typeof ops.sendUpload>[2], options?: Parameters<typeof ops.sendUpload>[3]): ReturnType<typeof ops.sendUpload>;\n");
            impl.append("    send: (file: FileInput, input?: Parameters<typeof ops.sendUpload>[2], options?: Parameters<typeof ops.sendUpload>[3]) => ops.sendUpload(c, file, input, options),\n");
        }
        if (n.kind == Kind.SCOPE && n.watch.isPresent()) followers(n, ids);
        if (n.kind == Kind.NAMESPACE && isIngestion(n)) syncMethod(n, ids);
        for (Node child : n.children.values()) {
            types.append("  readonly ").append(child.name).append(": ").append(nameOf(child)).append(";\n");
            impl.append("    ").append(child.name).append(": ").append(childExpr(child, ids)).append(",\n");
        }
    }

    // ------------------------------------------------------------------------------------------------ methods

    /** How a method takes its arguments and builds the operation's input. */
    private final class Plan {
        final Method m;
        final OperationShape op;
        final StructureShape in;
        final String inName;
        final String outName;
        final String fn;
        final List<MemberShape> options;
        final boolean optionsRequired;
        final Set<String> excluded = new LinkedHashSet<>();
        String uploadMember;          // a top-level @uploadTarget member: the file is the first argument
        boolean nestedUpload;         // an @uploadTarget at a dotted path: the input takes the file there
        MemberShape positional;
        final List<MemberShape> rest = new ArrayList<>();
        String readersMember;

        Plan(Method m) {
            this.m = m;
            this.op = m.operation;
            this.in = g.input(op);
            this.inName = g.typeName(op.getInputShape());
            this.outName = g.resultType(op);
            this.fn = FacadeGenerator.lowerCamelName(op);
            modelTypes.add(inName);
            modelTypes.add(outName);
            this.options = g.optionMembers(op);
            this.optionsRequired = options.stream().anyMatch(o -> o.hasTrait(RequiredTrait.class));
            for (ScopeTree.Fill f : m.fills) excluded.add(f.member());
            for (MemberShape o : options) excluded.add(o.getMemberName());
            for (MemberShape mm : in.getAllMembers().values()) {
                // A @fromScope member is filled on its own scope, and sent nowhere else (`kb.access.get()` sends neither).
                if (mm.findTrait(ScopeTree.FROM_SCOPE).isPresent()) excluded.add(mm.getMemberName());
            }
            FacadeGenerator.uploadTargetOf(op).ifPresent(t -> {
                if (t.contains(".")) nestedUpload = true;
                else uploadMember = t;
            });
            for (MemberShape mm : in.getAllMembers().values()) {
                if (excluded.contains(mm.getMemberName()) || mm.getMemberName().equals(uploadMember)) continue;
                rest.add(mm);
                if (isReaders(mm)) readersMember = mm.getMemberName();
            }
            List<MemberShape> required = rest.stream().filter(x -> x.hasTrait(RequiredTrait.class)).toList();
            if (uploadMember == null && !nestedUpload && required.size() == 1 && rest.size() <= 3 && !required.get(0).getMemberName().equals(readersMember)) {
                positional = required.get(0);
                rest.remove(positional);
            }
        }

        String restType() {
            Set<String> omit = new LinkedHashSet<>(excluded);
            if (uploadMember != null) omit.add(uploadMember);
            if (positional != null) omit.add(positional.getMemberName());
            // The operation function's own input type where it takes files in place of upload ids (a nested upload target,
            // a message's attachments).
            String base = nestedUpload || g.attachmentMember(op).isPresent() ? "Parameters<typeof ops." + fn + ">[1]" : inName;
            if (readersMember != null) omit.add(readersMember);
            String t = omit.isEmpty() ? base : "Omit<" + base + ", " + omit.stream().map(ScopeEmitter.this::str).collect(Collectors.joining(" | ")) + ">";
            if (readersMember != null) t += " & { " + readersMember + "?: " + inName + "[" + str(readersMember) + "] | ReadersShorthand }";
            return t;
        }

        boolean restRequired() {
            return rest.stream().anyMatch(x -> x.hasTrait(RequiredTrait.class));
        }

        String optionsType(boolean estimate) {
            if (estimate || options.isEmpty()) return "CallOptions";
            return "CallOptions & { " + options.stream().map(o -> o.getMemberName() + (o.hasTrait(RequiredTrait.class) ? ": string" : "?: string"))
                .collect(Collectors.joining("; ")) + " }";
        }

        /** The parameters, as a TypeScript parameter list. */
        String params(boolean estimate) {
            List<String> p = new ArrayList<>();
            for (String l : m.leading) p.add(l + ": string");
            if (uploadMember != null) p.add(estimate ? "file: FileInput | UploadDescription" : "file: FileInput | { " + uploadMember + ": string }");
            if (positional != null) p.add(positional.getMemberName() + ": " + inName + "[" + str(positional.getMemberName()) + "]");
            boolean optRequired = optionsRequired && !estimate;
            // An estimate takes the job's arguments, but needs only what describes the work: the rest may be left out.
            if (!rest.isEmpty()) p.add("input" + ((restRequired() || optRequired) && !estimate ? "" : "?") + ": " + (estimate ? "Partial<" + restType() + ">" : restType()));
            p.add("options" + (optRequired ? "" : "?") + ": " + optionsType(estimate));
            return String.join(", ", p);
        }

        /** The operation's input, from the arguments and the scope's identifiers. */
        String inputExpr(String ids) {
            List<String> parts = new ArrayList<>();
            if (!rest.isEmpty()) parts.add("...input");
            if (readersMember != null) parts.add(readersMember + ": readers(input?." + readersMember + ")");
            if (positional != null) parts.add(positional.getMemberName());
            if (uploadMember != null) parts.add("...(" + str(uploadMember) + " in Object(file) ? (file as object) : { file })");
            for (ScopeTree.Fill f : m.fills) {
                String v = m.leading.contains(f.identifier()) ? f.identifier() : ids + "." + f.identifier();
                parts.add(f.member() + ": " + (f.trimSlashes() ? "trimFolder(" + v + ")" : v));
            }
            return "{ " + String.join(", ", parts) + " } as Parameters<typeof ops." + fn + ">[1]";
        }

        String call(String ids) {
            return "ops." + fn + "(c, " + inputExpr(ids) + ", options)";
        }
    }

    private void method(Node n, Method m, String ids) {
        Plan p = new Plan(m);
        String doc = FacadeGenerator.docOf(p.op, "  ");
        String plain = "ReturnType<typeof ops." + p.fn + ">";
        String type;
        String body;
        boolean sse = p.op.hasTrait(SSE_EVENTS);
        boolean finalEvent = sse && p.op.findTrait(SSE_EVENTS).map(t -> t.toNode().expectObjectNode().getStringMember("final").isPresent()).orElse(false);
        if (m.creates.isPresent()) {
            Node scope = m.creates.get().collection().scope;
            String source = m.creates.get().source();
            // A create that returns the thing (one type per thing) resolves to the scope and the thing; one whose
            // response holds the thing beside other members (a document and its operation) to the scope, the thing and
            // those members.
            boolean returnsThing = g.thingOf(p.op).isPresent();
            String thingKey = thingMember(source);
            if (returnsThing && thingKey != null) source = "output:" + source.substring(("output:" + thingKey + ".").length());
            if (returnsThing) thingKey = null;
            String out0 = "Out<" + p.outName + ">";
            String thingType = returnsThing || thingKey == null ? out0
                : "NonNullable<" + out0 + "[" + str(thingKey) + "]> & Omit<" + out0 + ", " + str(thingKey) + ">";
            String created = "Created<" + nameOf(scope) + ", " + thingType + ">";
            String newIds = "{ ..." + ids + ", " + ownId(scope).orElseThrow() + ": " + sourceExpr(source, "out", "input", p) + " }";
            String make = "make" + nameOf(scope) + "(c, " + newIds + ")";
            String fields = "withFields(" + make + ", out" + (thingKey == null ? "" : ", out." + thingKey) + ")";
            if (m.longRunning.isPresent()) {
                if (scope.watch.isEmpty()) throw new CodegenException(p.op.getId() + ": a long-running create of " + scope.path() + ", which has no watch");
                String job = jobExpr(p.op, "out");
                String spec = "{ ...spec" + nameOf(scope) + "(c, " + newIds + ")" + (job == null ? "" : ", jobId: " + job) + " }";
                String event = eventsType(scope.watch.get().watch());
                type = "WorkPromise<" + created + ", " + created + ", " + event + ">";
                body = "new WorkPromise(" + p.call(ids) + ".then((out) => " + fields + " as unknown as " + created + "), (created) => {\n"
                    + "      const out = created as unknown as Out<" + p.outName + ">;\n"
                    + "      return {\n"
                    + "        wait: async (o?: WaitOptions) => withFields(" + make + ", out, (await waitFor(" + spec + ", o)) ?? " + (thingKey == null ? "out" : "out." + thingKey) + ") as unknown as " + created + ",\n"
                    + "        watch: (o?: CallOptions) => " + watchCall(scope, newIds, "o") + ",\n"
                    + "      };\n    })";
            } else {
                type = "Promise<" + created + ">";
                body = p.call(ids) + ".then((out) => " + fields + " as unknown as " + created + ")";
            }
        } else if (m.longRunning.isPresent()) {
            String[] w = follow(n, m, p, ids);
            type = "WorkPromise<Awaited<" + plain + ">, " + w[0] + ", " + w[2] + ">";
            body = "new WorkPromise(" + p.call(ids) + ", (out) => (" + w[1] + "))";
        } else if (finalEvent) {
            type = plain;
            body = "eager(" + p.call(ids) + ")";
        } else {
            type = plain;
            body = p.call(ids);
        }
        String params = p.params(false);
        String arrow = "(" + params + "): " + type + " => " + body;
        if (m.estimate.isPresent()) {
            Plan e = new Plan(m.estimate.get());
            String eType = "ReturnType<typeof ops." + e.fn + ">";
            String eParams = estimateParams(p, e);
            types.append(doc).append("  ").append(m.name).append(": {\n    (").append(params).append("): ").append(type).append(";\n")
                .append("    /** ").append(titleOf(e.op)).append(": what it would do and cost, with the same arguments. Nothing is started. */\n")
                .append("    estimate(").append(eParams).append("): ").append(eType).append(";\n  };\n");
            impl.append("    ").append(m.name).append(": Object.assign(").append(arrow).append(", {\n      estimate: async (").append(eParams).append("): Promise<Awaited<").append(eType).append(">> => ")
                .append(estimateCall(m, p, e, ids)).append(",\n    }),\n");
        } else {
            types.append(doc).append("  ").append(m.name).append("(").append(params).append("): ").append(type).append(";\n");
            impl.append("    ").append(m.name).append(": ").append(arrow).append(",\n");
        }
    }

    /** The member of a create's response that holds the new thing, or null when the response is the thing. */
    private static String thingMember(String source) {
        if (!source.startsWith("output:")) return null;
        String path = source.substring("output:".length());
        return path.contains(".") ? path.substring(0, path.indexOf('.')) : null;
    }

    /** Where the new scope's identifier comes from: the response (`output:document.id`) or the call's input (`input:path`). */
    private String sourceExpr(String source, String out, String input, Plan p) {
        String path = source.substring(source.indexOf(':') + 1);
        if (source.startsWith("output:")) return out + "." + path.replace(".", "!.");
        if (p.positional != null && p.positional.getMemberName().equals(path)) return path;
        return input + "!." + path;
    }

    /** The job a call's response names: its `operation` or `job` member's id. */
    private String jobExpr(OperationShape op, String out) {
        Optional<MemberShape> thing = g.thingOf(op);
        if (thing.isPresent()) {
            String t = thing.get().getTarget().getName();
            return t.equals("Operation") || t.equals("Job") ? out + ".id" : null;
        }
        StructureShape output = model.expectShape(op.getOutputShape(), StructureShape.class);
        for (MemberShape mm : output.getAllMembers().values()) {
            String target = mm.getTarget().getName();
            if (target.equals("Operation") || target.equals("Job")) return out + "." + mm.getMemberName() + "?.id";
        }
        return null;
    }

    /**
     * How a call that starts work (not a create) is followed: [the type wait() returns, the Follow object, the
     * watch's event type]. With a filter, through the scope it was made on (a document, a folder); a delete ends when
     * the thing is gone. Without one, through the knowledge base: its own delete, or the job the call started.
     */
    private String[] follow(Node n, Method m, Plan p, String ids) {
        ScopeTree.LongRunning lr = m.longRunning.get();
        String event = eventsType(lr.watch());
        String job = jobExpr(p.op, "out");
        Node scope = n;
        while (scope != null && scope.kind != Kind.SCOPE) scope = scope.parent;
        boolean isDelete = m.name.equals("delete") && scope == n;
        if (scope != null && scope.watch.isPresent() && (lr.filter().isPresent() || isDelete) && scope.watch.get().filter().equals(lr.filter())) {
            String specType = specType(scope);
            // A call that cancels the work it follows (@longRunning(cancels: true)): its wait returns the thing once the
            // work has stopped, never CANCELLED for the job it cancelled (wait.cancel-returns).
            boolean isCancel = lr.cancels();
            String spec = "{ ...spec" + nameOf(scope) + "(c, " + ids + ")" + (job == null ? "" : ", jobId: " + job) + (isDelete ? ", deleting: true" : "") + (isCancel ? ", cancelling: true" : "") + " }";
            String waitType = isDelete ? "void" : specType;
            String follow = "{\n        wait: async (o?: WaitOptions) => (await waitFor(" + spec + ", o)) as " + waitType + ",\n"
                + "        watch: (o?: CallOptions) => " + watchCall(scope, ids, "o") + ",\n      }";
            return new String[] {waitType, follow, event};
        }
        if (job == null) throw new CodegenException(p.op.getId() + ": a long-running call with no filter must return its job");
        // Only the job follows the work (a fill-in, reprocessing, layout-aware search): the knowledge base's watch.
        OperationShape watchOp = model.expectShape(lr.watch(), OperationShape.class);
        String watchFn = FacadeGenerator.lowerCamelName(watchOp);
        String fills = watchFills(watchOp, ids, null, null);
        String jobType = jobType(p.op);
        String follow = "{\n        wait: async (o?: WaitOptions) => (await waitForJob({ watch: (signal) => ops." + watchFn + "(c, " + fills + ", { signal }), jobId: " + job + "!, toError, jobError }, o)) as " + jobType + ",\n"
            + "        watch: (o?: CallOptions) => ops." + watchFn + "(c, " + fills + ", o),\n      }";
        return new String[] {jobType, follow, event};
    }

    private String jobType(OperationShape op) {
        StructureShape output = model.expectShape(op.getOutputShape(), StructureShape.class);
        for (MemberShape mm : output.getAllMembers().values()) {
            String target = mm.getTarget().getName();
            if (target.equals("Operation") || target.equals("Job")) {
                String t = g.typeName(mm.getTarget());
                modelTypes.add(t);
                return t;
            }
        }
        throw new CodegenException(op.getId() + ": no job in the response");
    }

    /** An estimate input member that describes a file (UploadDescription, or a list of them). */
    private boolean describes(MemberShape mm) {
        Shape target = model.expectShape(mm.getTarget());
        return target.getId().getName().equals("UploadDescription")
            || target instanceof ListShape l && l.getMember().getTarget().getName().equals("UploadDescription");
    }

    /** The estimate's own members, less the scope's, the call options and the file's description. */
    private List<MemberShape> ownRest(Plan ep) {
        return ep.in.getAllMembers().values().stream().filter(mm -> !ep.excluded.contains(mm.getMemberName()) && !describes(mm)).toList();
    }

    /**
     * An estimate's parameters. A file job's estimate takes the file (or its description) and the estimate's own
     * members only (`kb.documents.create.estimate(file, options)`); any other estimate takes its job's arguments.
     */
    private String estimateParams(Plan jp, Plan ep) {
        if (jp.uploadMember == null) return jp.params(true);
        List<String> p = new ArrayList<>();
        for (String l : jp.m.leading) p.add(l + ": string");
        p.add("file: FileInput | UploadDescription");
        List<MemberShape> own = ownRest(ep);
        if (!own.isEmpty()) {
            Set<String> omit = new LinkedHashSet<>(ep.excluded);
            ep.in.getAllMembers().values().stream().filter(this::describes).forEach(mm -> omit.add(mm.getMemberName()));
            p.add("input?: Omit<" + ep.inName + ", " + omit.stream().map(this::str).collect(Collectors.joining(" | ")) + ">");
        }
        p.add("options?: CallOptions");
        return String.join(", ", p);
    }

    /** An estimate called with its job's arguments: a file becomes its description; other members by name. */
    private String estimateCall(Method job, Plan jp, Plan ep, String ids) {
        List<String> parts = new ArrayList<>();
        for (MemberShape mm : ep.in.getAllMembers().values()) {
            String name = mm.getMemberName();
            if (ep.excluded.contains(name)) continue;
            Shape target = model.expectShape(mm.getTarget());
            boolean description = target.getId().getName().equals("UploadDescription");
            boolean descriptions = target instanceof ListShape l && l.getMember().getTarget().getName().equals("UploadDescription");
            if (description || descriptions) {
                if (jp.uploadMember == null) throw new CodegenException(ep.op.getId() + " describes a file, but its job " + jp.op.getId() + " takes none");
                String d = "await describeFile(file, toError, options?.signal)";
                parts.add(name + ": " + (descriptions ? "[" + d + "]" : d));
            } else if (jp.positional != null && jp.positional.getMemberName().equals(name)) {
                parts.add(name);
            } else if (jp.uploadMember != null ? ownRest(ep).stream().anyMatch(r -> r.getMemberName().equals(name))
                : jp.rest.stream().anyMatch(r -> r.getMemberName().equals(name))) {
                parts.add(name + ": input?." + name);
            }
        }
        for (ScopeTree.Fill f : ep.m.fills) {
            String v = job.leading.contains(f.identifier()) ? f.identifier() : ids + "." + f.identifier();
            parts.add(f.member() + ": " + (f.trimSlashes() ? "trimFolder(" + v + ")" : v));
        }
        return "ops." + ep.fn + "(c, { " + String.join(", ", parts) + " } as Parameters<typeof ops." + ep.fn + ">[1], options)";
    }

    // ------------------------------------------------------------------------------------------------ watch and wait

    /** The watch operation's input for a scope: its labels from the identifiers, and the filter member set to the scope's own. */
    /** An identifiers expression to read a member of: a name as it is, an object literal as `Ids`. */
    private static String idsRef(String ids) {
        return ids.matches("[A-Za-z_$][A-Za-z0-9_$]*") ? ids : "(" + ids + " as Ids)";
    }

    private String watchFills(OperationShape watchOp, String ids, String filter, String value) {
        ids = idsRef(ids);
        StructureShape in = g.input(watchOp);
        List<String> parts = new ArrayList<>();
        for (MemberShape mm : in.getAllMembers().values()) {
            if (mm.hasTrait(software.amazon.smithy.model.traits.HttpLabelTrait.class)) parts.add(mm.getMemberName() + ": " + ids + "." + mm.getMemberName());
        }
        if (filter != null) parts.add(filter + ": " + value);
        return "{ " + String.join(", ", parts) + " } as Parameters<typeof ops." + FacadeGenerator.lowerCamelName(watchOp) + ">[1]";
    }

    private String watchCall(Node scope, String ids, String options) {
        ScopeTree.LongRunning lr = scope.watch.get();
        OperationShape watchOp = model.expectShape(lr.watch(), OperationShape.class);
        String value = lr.filter().map(f -> idsRef(ids) + "." + ownId(scope).orElseThrow()).orElse(null);
        return "ops." + FacadeGenerator.lowerCamelName(watchOp) + "(c, " + watchFills(watchOp, ids, lr.filter().orElse(null), value) + ", " + options + ")";
    }

    private Optional<Method> getOf(Node scope) {
        return scope.methods.stream().filter(x -> x.name.equals("get")).findFirst();
    }

    /** What a scope's wait() returns: what its get returns, or (without a get) the watch's own view of it. */
    private String specType(Node scope) {
        Optional<Method> get = getOf(scope);
        if (get.isPresent()) {
            String out = g.resultType(get.get().operation);
            modelTypes.add(out);
            return "Out<" + out + ">";
        }
        ScopeTree.LongRunning lr = scope.watch.get();
        MemberShape snapshot = snapshotMember(lr.watch());
        StructureShape s = model.expectShape(snapshot.getTarget(), StructureShape.class);
        String kind = kindOf(scope);
        MemberShape member = s.getMember(kind).orElseThrow(() -> new CodegenException(snapshot.getTarget() + " has no " + kind));
        return "NonNullable<" + typeRef(snapshot.getTarget()) + "[" + str(member.getMemberName()) + "]>";
    }

    /** A structure's TypeScript name, imported from the models or from events.ts. */
    private String typeRef(ShapeId id) {
        String t = g.tsType(id);
        if (g.isModelled(id)) modelTypes.add(t);
        else eventTypes.add(t);
        return t;
    }

    /** The watch's events union, as events.ts names it. */
    private String eventsType(ShapeId watch) {
        OperationShape op = model.expectShape(watch, OperationShape.class);
        String union = ShapeId.from(op.findTrait(SSE_EVENTS).get().toNode().expectObjectNode().expectStringMember("events").getValue()).getName();
        eventTypes.add(union);
        return union;
    }

    private MemberShape snapshotMember(ShapeId watch) {
        OperationShape op = model.expectShape(watch, OperationShape.class);
        ShapeId union = ShapeId.from(op.findTrait(SSE_EVENTS).get().toNode().expectObjectNode().expectStringMember("events").getValue());
        return model.expectShape(union, UnionShape.class).getAllMembers().values().stream()
            .filter(mm -> mm.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(mm.getMemberName()).equals("snapshot"))
            .findFirst().orElseThrow(() -> new CodegenException(watch + " has no snapshot event"));
    }

    /** What a scope's watch reports on, as its snapshot names it: the filter, or the resource (`knowledgeBase`). */
    private static String kindOf(Node scope) {
        return scope.watch.get().filter().orElseGet(() -> {
            String r = scope.resource.orElseThrow().getId().getName().replaceFirst("Resource$", "");
            return Character.toLowerCase(r.charAt(0)) + r.substring(1);
        });
    }

    /** spec<Scope>(c, ids): how wait() follows the scope, for the scope itself and for the calls that start work on it. */
    private void followers(Node n, String ids) {
        String type = nameOf(n);
        String specType = specType(n);
        Optional<Method> get = getOf(n);
        String getExpr = get.map(gm -> {
            Plan gp = new Plan(gm);
            return "(signal: AbortSignal) => ops." + gp.fn + "(c, " + gp.inputExpr("ids") + ", { signal })";
        }).orElse(null);
        String own = ownId(n).orElseThrow();
        impl.insert(0, "/** How `" + n.path() + "` is waited on: its watch, and its get. */\n"
            + "function spec" + type + "(c: CaitlynClient, ids: Ids): WaitSpec<" + specType + "> {\n"
            + "  return {\n"
            + "    watch: (signal: AbortSignal) => " + watchCall(n, "ids", "{ signal }") + " as AsyncIterable<Record<string, any>>,\n"
            + "    kind: " + str(kindOf(n)) + ",\n"
            + "    id: ids." + own + ",\n"
            + (getExpr != null ? "    get: " + getExpr + ",\n" : "")
            + "    toError,\n    jobError,\n  };\n}\n\n");
        boolean hasWatch = n.methods.stream().anyMatch(x -> x.name.equals("watch"));
        if (!hasWatch) {
            // A scope's watch: each event's `processing` is the watched thing's (PROTOCOL.md 16, watch.processing).
            String events = eventsType(n.watch.get().watch());
            String watchType = "SseStream<" + events + " & ScopeWatchAccessor, never>";
            types.append("  /** Follows it: a snapshot first, then each change; a dropped connection reconnects and starts with a snapshot again. `event.processing` is its processing. */\n")
                .append("  watch(options?: CallOptions): ").append(watchType).append(";\n");
            impl.append("    watch: (options?: CallOptions) => ").append(watchCall(n, ids, "options")).append(" as unknown as ").append(watchType).append(",\n");
        }
        types.append("  /**\n   * Returns it, as its get would, once no job on it is running; with the partial failures of a job that ended\n")
            .append("   * completed_with_failures. Raises a failed job's error, CANCELLED for a cancelled one, and a 404 when it is gone.\n   */\n")
            .append("  wait(options?: WaitOptions): Promise<").append(specType).append(">;\n");
        impl.append("    wait: async (options?: WaitOptions) => (await waitFor(spec").append(type).append("(c, ").append(ids).append("), options)) as ").append(specType).append(",\n");
        if (get.isPresent() && hasPlannedStatus(get.get().operation)) {
            types.append("  /** Returns it once it is planned or past it (PROTOCOL.md 16); raises its failure when planning failed it. */\n")
                .append("  planned(options?: WaitOptions): Promise<").append(specType).append(">;\n");
            impl.append("    planned: async (options?: WaitOptions) => (await waitFor({ ...spec").append(type).append("(c, ").append(ids).append("), until: \"planned\" }, options)) as ").append(specType).append(",\n");
        }
        if (g.hasSyncOperations() && n == batchScope()) uploadMethod(n, ids, type, specType);
    }

    /**
     * batch.upload(files, options) and batch.upload.estimate(files?) (PROTOCOL.md 15): the two steps of a hand-built
     * batch that sync has, from sdk-core's batchUpload and estimateUpload, with this client's calls.
     */
    private void uploadMethod(Node n, String ids, String type, String specType) {
        String own = idsRef(ids) + "." + ownId(n).orElseThrow();
        String kb = idsRef(ids) + ".knowledgeBaseId";
        String event = eventsType(n.watch.get().watch());
        String result = "BatchUpload<__SyncReportBatch, __SyncReportItem>";
        String files = "BatchFiles<FileInput, __SyncReportItem>";
        String options = "CallOptions & BatchUploadOptions<__SyncReportItem>";
        String work = "WorkPromise<" + result + ", " + specType + ", " + event + ">";
        String estimateFiles = "BatchFiles<FileInput | UploadDescription, __SyncReportItem>";
        String estimate = "ReturnType<typeof ops.estimateIngestion>";
        types.append("  /**\n   * Sends the batch's file items that await upload, each from the file given for its path (`/hr/leave.pdf`, or a\n")
            .append("   * function of the item), under the batch's upload policy (PROTOCOL.md 15). The batch must be started. Awaiting it\n")
            .append("   * gives the batch, the items it dealt with (`ingesting`, or `failed` with a failureCode), the paths of items given\n")
            .append("   * no file (`notGiven`, left awaiting upload) and the given paths that matched no item (`unmatched`); `.wait()`\n")
            .append("   * returns the batch once it has finished. Cancelling stops the uploads and leaves the batch as it is.\n   */\n")
            .append("  upload: {\n    (files: ").append(files).append(", options?: ").append(options).append("): ").append(work).append(";\n")
            .append("    /**\n     * What uploading the batch's file items would take and cost, before it is started. Each document is described by\n")
            .append("     * its file's name, content type and size, with the hints given with the file (withHints), or without files by the\n")
            .append("     * item itself; nothing is read or hashed. A batch still planning is waited on; a draft is refused.\n     */\n")
            .append("    estimate(files?: ").append(estimateFiles).append(", options?: WaitOptions): ").append(estimate).append(";\n  };\n");
        impl.append("    upload: Object.assign((files: ").append(files).append(", options: ").append(options).append(" = {}): ").append(work).append(" =>\n")
            .append("      new WorkPromise(batchUpload(syncDeps(c, ").append(idsRef(ids)).append("), ").append(kb).append(", ").append(own).append(", files as BatchFiles, options as BatchUploadOptions) as Promise<").append(result).append(">, () => ({\n")
            .append("        wait: async (o?: WaitOptions) => (await waitFor(spec").append(type).append("(c, ").append(ids).append("), o)) as ").append(specType).append(",\n")
            .append("        watch: (o?: CallOptions) => ").append(watchCall(n, ids, "o")).append(",\n")
            .append("      })), {\n")
            .append("      estimate: (files?: ").append(estimateFiles).append(", options?: WaitOptions) => estimateUpload(syncDeps(c, ").append(idsRef(ids)).append("), ").append(kb).append(", ").append(own).append(", files as BatchFiles<FileInput | UploadDescription>, options) as ").append(estimate).append(",\n")
            .append("    }),\n");
    }

    private boolean hasPlannedStatus(OperationShape get) {
        // The thing the get returns (one type per thing), or its output.
        ShapeId shape = g.thingOf(get).map(MemberShape::getTarget).orElse(get.getOutputShape());
        StructureShape out = model.expectShape(shape, StructureShape.class);
        return out.getMember("status").map(mm -> model.expectShape(mm.getTarget())).filter(s -> s instanceof EnumShape).map(s -> ((EnumShape) s).getAllMembers().values().stream()
            .anyMatch(v -> v.expectTrait(EnumValueTrait.class).expectStringValue().equals("planned"))).orElse(false);
    }

    // ------------------------------------------------------------------------------------------------ ingestion.sync

    private boolean isIngestion(Node n) {
        if (!g.hasSyncOperations()) return false;
        return n.children.values().stream().anyMatch(c -> c.kind == Kind.COLLECTION && c.resource.flatMap(ResourceShape::getCreate)
            .map(id -> id.getName().equals("CreateIngestionBatch")).orElse(false));
    }

    private Node batchScope() {
        for (Node n : tree.root.walk()) {
            if (n.kind == Kind.COLLECTION && n.resource.flatMap(ResourceShape::getCreate).map(id -> id.getName().equals("CreateIngestionBatch")).orElse(false)) return n.scope;
        }
        throw new CodegenException("No ingestion batch scope");
    }

    private String syncDeps() {
        Node batch = batchScope();
        String own = ownId(batch).orElseThrow();
        StringBuilder out = new StringBuilder("/** The Commands kb.ingestion.sync sends, by operation. */\nconst SYNC_COMMANDS: Record<string, new (input: any) => any> = {\n");
        for (String op : FacadeGenerator.SYNC_OPERATIONS) out.append("  ").append(op).append(": ").append(op).append("Command,\n");
        out.append("};\n\n/** The member that holds the thing, for each sync call that returns one: the call gives sync the thing. */\n")
            .append("const SYNC_THINGS: Record<string, string> = {");
        List<String> things = new ArrayList<>();
        for (String op : FacadeGenerator.SYNC_OPERATIONS) {
            g.thingOf(model.expectShape(ShapeId.fromParts(g.serviceNamespace(), op), OperationShape.class))
                .ifPresent(t -> things.add(" " + op + ": " + str(t.getMemberName())));
        }
        out.append(String.join(",", things)).append(" };\n\n/** What kb.ingestion.sync needs from this client: its calls, and a batch's planned() and wait(). */\n")
            .append("function syncDeps(c: CaitlynClient, ids: Ids): SyncDeps {\n")
            .append("  const s = storage(c);\n")
            .append("  const batch = (id: string) => spec").append(nameOf(batch)).append("(c, { ...ids, ").append(own).append(": id });\n")
            .append("  return {\n")
            .append("    call: async (operation, input, signal) => {\n      const out = await c.send(new SYNC_COMMANDS[operation](input), { abortSignal: signal });\n      return SYNC_THINGS[operation] ? thingOf(out, SYNC_THINGS[operation]) : out;\n    },\n")
            .append("    toError,\n    tracer: s.tracer,\n    maxAttempts: s.maxAttempts,\n    maxRetryDelayMs: s.maxRetryDelayMs,\n")
            .append("    planned: async (id, o) => (await waitFor({ ...batch(id), until: \"planned\" }, o)) as Record<string, any>,\n")
            .append("    finished: async (id, onBatch, o) => (await waitFor({ ...batch(id), onThing: onBatch }, o)) as Record<string, any>,\n")
            .append("    describe: (file) => describeFile(file, toError) as Promise<Record<string, any>>,\n")
            .append("  };\n}\n\n");
        return out.toString();
    }

    private void syncMethod(Node n, String ids) {
        types.append("  /**\n   * Keeps the knowledge base in step with a folder of files, or a list of items, through one ingestion batch\n")
            .append("   * (PROTOCOL.md 15). Files are keyed by their path below the folder and go to `/` unless `folder` says otherwise.\n")
            .append("   * Returns its report: the batch as reading it gives it, and every item as listing the batch's items gives it.\n   * `sync.estimate` plans the batch and prices it, uploading nothing.\n   */\n")
            .append("  sync: {\n    (source: string | SyncItemInput[], options?: SyncOptions): Promise<SyncReport<__SyncReportBatch, __SyncReportItem>>;\n")
            .append("    /** What sync would do and cost: the planned batch, every item's outcome and the estimate. Nothing is uploaded. */\n")
            .append("    estimate(source: string | SyncItemInput[], options?: SyncOptions): Promise<SyncPlan>;\n  };\n");
        impl.append("    sync: Object.assign((source: string | SyncItemInput[], options?: SyncOptions) => runSync(syncDeps(c, ").append(ids).append("), ").append(ids).append(".knowledgeBaseId, source, options) as Promise<SyncReport<__SyncReportBatch, __SyncReportItem>>, {\n")
            .append("      estimate: (source: string | SyncItemInput[], options?: SyncOptions) => estimateSync(syncDeps(c, ").append(ids).append("), ").append(ids).append(".knowledgeBaseId, source, options),\n")
            .append("    }),\n");
    }

    // ------------------------------------------------------------------------------------------------ the client

    private String rootClass() {
        String name = service.getId().getName();
        StringBuilder out = new StringBuilder("/** The Caitlyn client: every operation, as scopes (`caitlyn.knowledgeBases(id).documents.create(file)`). */\n")
            .append("export class ").append(name).append(" {\n")
            .append("  readonly client: CaitlynClient;\n")
            .append("  /** The sign-in session: the current token, and the oauth mode's authorizationUrl(), handleCallback() and signOut(). */\n")
            .append("  readonly auth: AuthSession;\n");
        Node root = tree.root;
        for (Node child : root.children.values()) {
            out.append("  readonly ").append(child.name).append(": ").append(nameOf(child)).append(";\n");
        }
        out.append("\n  constructor(options: CaitlynOptions) {\n    this.auth = createAuth(options);\n    this.client = createCaitlynClient(options, this.auth);\n")
            .append("    const c = this.client;\n");
        for (Node child : root.children.values()) {
            out.append("    this.").append(child.name).append(" = ").append(childExpr(child, "{}")).append(";\n");
        }
        out.append("  }\n");
        for (Method m : root.methods) {
            Plan p = new Plan(m);
            out.append("\n").append(FacadeGenerator.docOf(p.op, "  ")).append("  ").append(m.name).append("(").append(p.params(false)).append("): ReturnType<typeof ops.").append(p.fn).append("> {\n")
                .append("    const c = this.client;\n    return ").append(p.call("({} as Ids)")).append(";\n  }\n");
        }
        return out.append("}\n").toString();
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /** A structure that is the readers shorthand's target: a required enum `kind` with a `specific` value. */
    private boolean isReaders(MemberShape m) {
        Shape t = model.expectShape(m.getTarget());
        if (!(t instanceof StructureShape s)) return false;
        return s.getMember("kind").filter(k -> k.hasTrait(RequiredTrait.class)).map(k -> model.expectShape(k.getTarget()))
            .filter(e -> e instanceof EnumShape).map(e -> ((EnumShape) e).getAllMembers().values().stream()
                .anyMatch(v -> v.expectTrait(EnumValueTrait.class).expectStringValue().equals("specific"))).orElse(false);
    }

    private static String titleOf(OperationShape op) {
        return op.findTrait(ShapeId.from("smithy.api#title")).map(t -> t.toNode().expectStringNode().getValue()).orElse(op.getId().getName());
    }

    private String str(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

}
