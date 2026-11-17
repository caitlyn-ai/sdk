package ai.caitlyn.codegen.typescript;

import ai.caitlyn.codegen.model.ResultNames;
import ai.caitlyn.codegen.model.SseEvents;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.UnaryOperator;
import java.util.stream.Collectors;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.PaginatedIndex;
import software.amazon.smithy.model.knowledge.PaginationInfo;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.neighbor.Walker;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.EnumShape;
import software.amazon.smithy.model.shapes.ListShape;
import software.amazon.smithy.model.shapes.MapShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.DocumentationTrait;
import software.amazon.smithy.model.traits.EnumValueTrait;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.HttpLabelTrait;
import software.amazon.smithy.model.traits.IdempotencyTokenTrait;
import software.amazon.smithy.model.traits.JsonNameTrait;
import software.amazon.smithy.model.traits.RequiredTrait;
import software.amazon.smithy.typescript.codegen.TypeScriptCodegenContext;

/**
 * Generates the method-style SDK under {@code src/sdk/} from the model:
 *
 * <ul>
 *   <li>{@code operations.ts}: one standalone function per operation ({@code listDocuments(client, input)}),
 *       so a single operation tree-shakes. Lists are async iterators over items; SSE operations return an
 *       {@code SseStream}; If-Match and idempotency tokens are call options, as in the proposal's examples;
 *       {@code @presignedUpload} and {@code @uploadTarget} produce the upload helpers.</li>
 *   <li>{@code events.ts}: types for every {@code @sseEvents} union, which smithy-typescript never generates
 *       because no operation reaches the union.</li>
 *   <li>{@code client.ts}: {@code createCaitlynClient(options)} and the namespaced {@code Caitlyn} object.</li>
 *   <li>{@code connection.ts}: {@code CaitlynConnectionError}, the error for a call that got no HTTP response.</li>
 *   <li>{@code index.ts}: the public entry. It exports model shapes (Input and Output types, structures,
 *       enums, errors) but no Command classes or CommandInput/CommandOutput types.</li>
 * </ul>
 *
 * <p>Namespaces and method names come from resources: the resource name, with any trailing "Resource" removed,
 * pluralised and lower-camel-cased, is the namespace; lifecycle operations are create, get, update, delete,
 * list and put. {@code @clientMethod} overrides both where the resource model does not fit.
 */
final class FacadeGenerator {

    private static final ShapeId CLIENT_METHOD = ShapeId.from("ai.caitlyn.traits#clientMethod");
    private static final ShapeId SSE_EVENTS = ShapeId.from("ai.caitlyn.traits#sseEvents");
    private static final ShapeId PRESIGNED_UPLOAD = ShapeId.from("ai.caitlyn.traits#presignedUpload");
    private static final ShapeId UPLOAD_TARGET = ShapeId.from("ai.caitlyn.traits#uploadTarget");

    private final Model model;
    private final ServiceShape service;
    private final TypeScriptCodegenContext context;
    private final Set<ShapeId> modelled = new TreeSet<>();
    /** Structures an @uploadTarget method's input type names, for operations.ts to import. */
    private final Set<String> nestedTypes = new TreeSet<>();
    private final SseEvents sseEvents;
    private final ResultNames results;
    /** The public name of each named result (ResultNames: EstimateIngestionResult), to the Smithy output type it names. */
    private final Map<String, String> resultAliases = new TreeMap<>();
    private final Map<ShapeId, String> resultNameOf = new HashMap<>();

    private record Method(String namespace, String name, String positional, ResourceShape resource) {}

    /** smithy.waiters#waitable: the model declares none; wait() does their job (PROTOCOL.md 10.1). */
    private static final ShapeId WAITABLE = ShapeId.from("smithy.waiters#waitable");

    FacadeGenerator(TypeScriptCodegenContext context) {
        this.context = context;
        this.model = context.model();
        this.service = context.settings().getService(model);
        this.sseEvents = new SseEvents(model, service);
        this.results = new ResultNames(model, service, UnaryOperator.identity());
        // Every named result is exported under the name the other SDKs and the docs use; a list's `…Page` is not, as
        // a list here is an async iterable of its items.
        for (Map.Entry<ShapeId, String> e : results.names().entrySet()) {
            String name = e.getValue();
            if (name.endsWith("Page") || e.getKey().getName().equals(name)) continue;
            resultAliases.putIfAbsent(name, context.symbolProvider().toSymbol(model.expectShape(e.getKey())).getName());
            resultNameOf.put(e.getKey(), name);
        }
        // Shapes smithy-typescript generates: everything operations reach (not trait references).
        for (OperationShape op : operations()) {
            new Walker(model).walkShapes(op).forEach(s -> modelled.add(s.getId()));
        }
    }

    List<OperationShape> operations() {
        return TopDownIndex.of(model).getContainedOperations(service).stream()
            .sorted((a, b) -> a.getId().getName().compareTo(b.getId().getName()))
            .toList();
    }

    void generate() {
        Map<OperationShape, Method> methods = new LinkedHashMap<>();
        for (OperationShape op : operations()) {
            methods.put(op, methodFor(op));
        }
        context.fileManifest().writeFile("src/sdk/events.ts", events());
        context.fileManifest().writeFile("src/sdk/results.ts", resultsFile());
        context.fileManifest().writeFile("src/sdk/problems.ts", problemsFile());
        context.fileManifest().writeFile("src/sdk/operations.ts", operationsFile(methods));
        context.fileManifest().writeFile("src/sdk/client.ts", new ScopeEmitter(this, model, service, context).clientFile());
        context.fileManifest().writeFile("src/sdk/connection.ts", connectionFile());
        context.fileManifest().writeFile("src/sdk/errors.ts", errorBaseFile());
        context.fileManifest().writeFile("src/sdk/index.ts", indexFile());
    }

    // ------------------------------------------------------------------ naming

    private Method methodFor(OperationShape op) {
        // The standalone functions take every identifier in their input; the scopes (client.ts) fill them.
        return new Method("", lowerCamel(op.getId().getName()), null, null);
    }

    /** An operation's standalone function name: `GetDocument` is `getDocument`. */
    static String lowerCamelName(OperationShape op) {
        return lowerCamel(op.getId().getName());
    }

    /** An operation's documentation as a JSDoc comment. */
    static String docOf(Shape shape, String indent) {
        return doc(shape, indent);
    }

    /** Whether smithy-typescript generates the shape (models_0 or enums), or events.ts does. */
    boolean isModelled(ShapeId id) {
        return modelled.contains(id);
    }

    /** A list member of {uploadId} structures (a message's attachments), which the SDK lets take files. */
    Optional<MemberShape> attachmentMember(OperationShape op) {
        return input(op).getAllMembers().values().stream().filter(m -> {
            Shape t = model.expectShape(m.getTarget());
            if (!(t instanceof ListShape l)) return false;
            Shape item = model.expectShape(l.getMember().getTarget());
            return item instanceof StructureShape st && st.getAllMembers().size() == 1 && st.getMember("uploadId").isPresent();
        }).findFirst();
    }

    /** The UploadPurpose member an attachment's reservation sets: the one named as one of the operation's labels. */
    private String purposeFor(OperationShape op) {
        StructureShape purpose = model.expectShape(ShapeId.fromParts(service.getId().getNamespace(), "UploadPurpose"), StructureShape.class);
        return input(op).getAllMembers().values().stream().filter(m -> m.hasTrait(HttpLabelTrait.class))
            .map(MemberShape::getMemberName).filter(n -> purpose.getMember(n).isPresent()).findFirst()
            .orElseThrow(() -> new CodegenException(op.getId() + ": attachments, but no UploadPurpose member names one of its labels"));
    }

    /** The member path of an operation's @uploadTarget, if it has one. */
    static Optional<String> uploadTargetOf(OperationShape op) {
        return uploadTarget(op);
    }

    private static String lowerCamel(String s) {
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    /** The thing an operation returns (one type per thing): its output's @httpPayload member, if it returns one. */
    Optional<MemberShape> thingOf(OperationShape op) {
        return results.payloadOf(op.getOutputShape());
    }

    /** What an operation's function resolves to: the thing it returns, or its output. */
    String resultType(OperationShape op) {
        return thingOf(op).map(m -> typeName(m.getTarget()))
            .orElseGet(() -> resultNameOf.getOrDefault(op.getOutputShape(), typeName(op.getOutputShape())));
    }

    /** Whether a type name is a named result's (exported from results.ts, not models_0). */
    boolean isResultName(String name) {
        return resultAliases.containsKey(name);
    }

    /** The imports of a generated file's types: models_0's, and the named results'. */
    String typeImports(Set<String> types) {
        List<String> models = types.stream().filter(t -> !isResultName(t)).toList();
        List<String> named = types.stream().filter(this::isResultName).toList();
        return (models.isEmpty() ? "" : "import type { " + String.join(", ", models) + " } from \"../models/models_0\";\n")
            + (named.isEmpty() ? "" : "import type { " + String.join(", ", named) + " } from \"./results\";\n");
    }

    /** results.ts: each named result under its public name, the type the call's output has. */
    private String resultsFile() {
        StringBuilder out = new StringBuilder(HEADER)
            .append("// Each call whose output is not a thing returns a named result: the same name in every SDK and the docs.\n")
            .append("import type { ").append(String.join(", ", new TreeSet<>(resultAliases.values()))).append(" } from \"../models/models_0\";\n\n");
        for (Map.Entry<String, String> e : resultAliases.entrySet()) {
            out.append("/** What ").append(e.getValue().replaceFirst("Output$", "")).append(" returns. */\n")
                .append("export type ").append(e.getKey()).append(" = ").append(e.getValue()).append(";\n");
        }
        return out.toString();
    }

    String serviceNamespace() {
        return service.getId().getNamespace();
    }

    String typeName(ShapeId id) {
        return context.symbolProvider().toSymbol(model.expectShape(id)).getName();
    }

    StructureShape input(OperationShape op) {
        return model.expectShape(op.getInputShape(), StructureShape.class);
    }

    /** Input members passed as call options rather than input fields: If-Match and idempotency tokens. */
    List<MemberShape> optionMembers(OperationShape op) {
        return input(op).getAllMembers().values().stream()
            .filter(m -> m.hasTrait(IdempotencyTokenTrait.class)
                || m.getTrait(HttpHeaderTrait.class).map(h -> h.getValue().equalsIgnoreCase("If-Match")).orElse(false))
            .toList();
    }

    static String doc(Shape shape, String indent) {
        return shape.getTrait(DocumentationTrait.class)
            .map(d -> indent + "/** " + d.getValue().replace("*/", "*\\/").replace("\n", "\n" + indent + " * ") + " */\n")
            .orElse("");
    }

    // ------------------------------------------------------------------ events.ts

    private String events() {
        StringBuilder out = new StringBuilder(HEADER);
        Set<ShapeId> unions = new LinkedHashSet<>();
        for (OperationShape op : operations()) {
            op.findTrait(SSE_EVENTS).ifPresent(t ->
                unions.add(ShapeId.from(t.toNode().expectObjectNode().expectStringMember("events").getValue())));
        }
        Set<ShapeId> needed = new TreeSet<>();
        Set<ShapeId> imported = new TreeSet<>();
        for (ShapeId u : unions) {
            new Walker(model).walkShapes(model.expectShape(u)).forEach(s -> {
                if (s.isStructureShape() || s.isEnumShape()) {
                    (modelled.contains(s.getId()) ? imported : needed).add(s.getId());
                }
            });
        }
        // smithy-typescript writes structures to models_0 and enums to enums.
        List<String> structs = imported.stream().filter(id -> !model.expectShape(id).isEnumShape()).map(this::typeName).toList();
        List<String> enums = imported.stream().filter(id -> model.expectShape(id).isEnumShape()).map(this::typeName).toList();
        if (!structs.isEmpty()) out.append("import type { ").append(String.join(", ", structs)).append(" } from \"../models/models_0\";\n");
        if (!enums.isEmpty()) out.append("import type { ").append(String.join(", ", enums)).append(" } from \"../models/enums\";\n");
        if (!imported.isEmpty()) out.append("\n");
        for (ShapeId u : unions) {
            UnionShape union = model.expectShape(u, UnionShape.class);
            String name = u.getName();
            out.append(doc(union, "")).append("export type ").append(name).append(" =\n");
            List<String> names = new ArrayList<>();
            for (MemberShape m : union.getAllMembers().values()) {
                String event = m.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(m.getMemberName());
                names.add(event);
                out.append("  | ({ type: \"").append(event).append("\"; eventId?: string } & ")
                    .append(m.getTarget().getName()).append(")\n");
            }
            out.append("  ;\n\n");
            out.append("/** The SSE event names this SDK version knows; any other event is skipped. */\n")
                .append("export const ").append(name).append("Names: ReadonlySet<string> = new Set([")
                .append(names.stream().map(n -> "\"" + n + "\"").collect(Collectors.joining(", ")))
                .append("]);\n\n");
        }
        for (ShapeId id : needed) {
            Shape s = model.expectShape(id);
            out.append(doc(s, ""));
            if (s instanceof EnumShape e) {
                out.append("export type ").append(id.getName()).append(" = ")
                    .append(e.getAllMembers().values().stream()
                        .map(m -> "\"" + m.expectTrait(EnumValueTrait.class).expectStringValue() + "\"")
                        .collect(Collectors.joining(" | ")))
                    .append(" | (string & {}); // open enum\n\n");
            } else {
                out.append("export interface ").append(id.getName()).append(" {\n");
                for (MemberShape m : ((StructureShape) s).getAllMembers().values()) {
                    String key = m.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(m.getMemberName());
                    out.append(doc(m, "  ")).append("  ").append(key)
                        .append(m.hasTrait(RequiredTrait.class) ? ": " : "?: ")
                        .append(tsType(m.getTarget())).append(";\n");
                }
                out.append("}\n\n");
            }
        }
        return out.toString();
    }

    /**
     * How a watch's events are read as the model's types (watch.event-types): for each event, the members whose
     * target the model's schemas describe (a structure, or a list of them), by their JSON name, with nested plans
     * for the events' own structures. The stream applies them to each event's data (sdk-core readEvent).
     */
    private String eventReads(UnionShape union, Set<String> schemaImports) {
        List<String> entries = new ArrayList<>();
        for (MemberShape m : union.getAllMembers().values()) {
            Shape target = model.expectShape(m.getTarget());
            if (!(target instanceof StructureShape st)) continue;
            String plan = structurePlan(st, schemaImports, new HashSet<>());
            if (plan != null) entries.add("\"" + SseEvents.wireName(m) + "\": " + plan);
        }
        return "{ " + String.join(", ", entries) + " }";
    }

    private String structurePlan(StructureShape s, Set<String> schemaImports, Set<ShapeId> visiting) {
        if (!visiting.add(s.getId())) return null;
        List<String> fields = new ArrayList<>();
        for (MemberShape m : s.getAllMembers().values()) {
            String key = m.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(m.getMemberName());
            String read = memberRead(model.expectShape(m.getTarget()), schemaImports, visiting);
            if (read != null) fields.add("\"" + key + "\": " + read);
        }
        visiting.remove(s.getId());
        return fields.isEmpty() ? null : "{ " + String.join(", ", fields) + " }";
    }

    private String memberRead(Shape t, Set<String> schemaImports, Set<ShapeId> visiting) {
        if (t instanceof StructureShape st) {
            if (modelled.contains(st.getId())) {
                String schema = typeName(st.getId()) + "$";
                schemaImports.add(schema);
                return schema;
            }
            String nested = structurePlan(st, schemaImports, visiting);
            return nested == null ? null : "{ $fields: " + nested + " }";
        }
        if (t instanceof ListShape l) {
            Shape item = model.expectShape(l.getMember().getTarget());
            if (item instanceof StructureShape st && modelled.contains(st.getId())) {
                String schema = typeName(st.getId()) + "$";
                schemaImports.add(schema);
                return "[1, \"" + l.getId().getNamespace() + "\", \"" + l.getId().getName() + "\", 0, () => " + schema + "]";
            }
            if (item instanceof StructureShape st) {
                String nested = structurePlan(st, schemaImports, visiting);
                return nested == null ? null : "{ $each: " + nested + " }";
            }
        }
        return null;
    }

    /** TypeScript type of a shape as it appears in parsed SSE JSON (timestamps stay RFC 3339 strings). */
    String tsType(ShapeId target) {
        Shape s = model.expectShape(target);
        return switch (s.getType()) {
            case STRING, BLOB, TIMESTAMP -> "string";
            case ENUM, STRUCTURE -> modelled.contains(target) ? typeName(target) : target.getName();
            case BOOLEAN -> "boolean";
            case BYTE, SHORT, INTEGER, LONG, FLOAT, DOUBLE, BIG_DECIMAL, BIG_INTEGER, INT_ENUM -> "number";
            case DOCUMENT -> "unknown";
            case LIST, SET -> tsType(((ListShape) s).getMember().getTarget()) + "[]";
            case MAP -> "Record<string, " + tsType(((MapShape) s).getValue().getTarget()) + ">";
            default -> "unknown";
        };
    }

    // ------------------------------------------------------------------ operations.ts

    private String operationsFile(Map<OperationShape, Method> methods) {
        Set<String> imports = new LinkedHashSet<>();
        StringBuilder body = new StringBuilder();
        // Each watch's events read as the model's types (watch.event-types): one plan per events union.
        Map<ShapeId, String> reads = new LinkedHashMap<>();
        Set<String> schemaImports = new TreeSet<>();
        Set<String> modelTypes = new TreeSet<>();
        Set<String> eventTypes = new TreeSet<>();
        imports.add("import type { CaitlynClient } from \"../CaitlynClient\";\n");
        imports.add("import { CaitlynServiceException } from \"../models/CaitlynServiceException\";\n");
        imports.add("import { SseStream, thingOf, type AsyncDisposableStream, type CallOptions, type WithRaw } from \"@caitlyn-ai/sdk-core\";\n");
        // A single call's output carries the response metadata (HTTP status, request id), as the command's does.
        imports.add("import type { MetadataBearer as __MetadataBearer } from \"@caitlyn-ai/sdk-core\";\n");

        imports.add("import { toError, storage } from \"./problems\";\n");

        PaginatedIndex paginated = PaginatedIndex.of(model);
        OperationShape presigned = null;
        for (OperationShape op : methods.keySet()) {
            String opName = op.getId().getName();
            String fn = lowerCamel(opName);
            Method m = methods.get(op);
            String in = typeName(op.getInputShape());
            String out = resultType(op);
            String unwrap = thingOf(op).map(t -> ".then((out) => thingOf<WithRaw<" + out + " & __MetadataBearer>>(out, \"" + t.getMemberName() + "\"))").orElse("");
            modelTypes.add(in);
            modelTypes.add(out);
            imports.add("import { " + opName + "Command } from \"../commands/" + opName + "Command\";\n");

            List<MemberShape> options = optionMembers(op);
            Set<String> omitted = new LinkedHashSet<>();
            options.forEach(o -> omitted.add(o.getMemberName()));
            if (m.positional() != null) omitted.add(m.positional());
            String inputType = omitted.isEmpty() ? in
                : "Omit<" + in + ", " + omitted.stream().map(o -> "\"" + o + "\"").collect(Collectors.joining(" | ")) + ">";
            boolean optionsRequired = options.stream().anyMatch(o -> o.hasTrait(RequiredTrait.class));
            String optionsType = options.isEmpty() ? "CallOptions"
                : "CallOptions & { " + options.stream().map(o -> o.getMemberName()
                    + (o.hasTrait(RequiredTrait.class) ? ": string" : "?: string")).collect(Collectors.joining("; ")) + " }";
            String optionsParam = "options: " + optionsType + (optionsRequired ? "" : " = {}");
            String positionalParam = m.positional() != null ? m.positional() + ": string, " : "";
            String commandInput = "{ ...input" + (m.positional() != null ? ", " + m.positional() : "") + ", ...rest }";

            body.append(doc(op, ""));
            Optional<ObjectNode> sse = op.findTrait(SSE_EVENTS).map(t -> t.toNode().expectObjectNode());
            Optional<PaginationInfo> page = paginated.getPaginationInfo(service, op);
            if (sse.isPresent()) {
                UnionShape union = model.expectShape(ShapeId.from(sse.get().expectStringMember("events").getValue()), UnionShape.class);
                String events = union.getId().getName();
                eventTypes.add(events);
                eventTypes.add(events + "Names");
                String finalType = "never";
                String finalSpec = "undefined";
                Optional<String> finalMember = sse.get().getStringMember("final").map(n -> n.getValue());
                if (finalMember.isPresent()) {
                    MemberShape fm = union.getMember(finalMember.get()).orElseThrow();
                    StructureShape fs = model.expectShape(fm.getTarget(), StructureShape.class);
                    MemberShape only = fs.getAllMembers().values().iterator().next();
                    finalType = tsType(only.getTarget());
                    if (!modelled.contains(only.getTarget())) eventTypes.add(finalType);
                    else modelTypes.add(finalType);
                    String event = fm.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(fm.getMemberName());
                    finalSpec = "{ event: \"" + event + "\", member: \"" + only.getMemberName() + "\" }";
                }
                // The failure event (PROTOCOL.md 5.5): the member whose target carries the problem details.
                String errorEvent = sseEvents.unions().get(union.getId()).failure()
                    .map(fm -> "\"" + SseEvents.wireName(fm) + "\"").orElse("undefined");
                String resume = "undefined";
                Optional<String> resumeWith = sse.get().getStringMember("resumeWith").map(n -> n.getValue());
                if (resumeWith.isPresent()) {
                    OperationShape r = model.expectShape(ShapeId.from(resumeWith.get()), OperationShape.class);
                    imports.add("import { " + r.getId().getName() + "Command } from \"../commands/" + r.getId().getName() + "Command\";\n");
                    List<String> fields = new ArrayList<>();
                    for (MemberShape rm : input(r).getAllMembers().values()) {
                        boolean lastEventId = rm.getTrait(HttpHeaderTrait.class)
                            .map(h -> h.getValue().equalsIgnoreCase("Last-Event-ID")).orElse(false);
                        if (lastEventId) fields.add(rm.getMemberName() + ": lastEventId");
                        else if (rm.hasTrait(HttpLabelTrait.class)) {
                            fields.add(rm.getMemberName().equals(m.positional()) ? rm.getMemberName()
                                : rm.getMemberName() + ": (input as unknown as Record<string, string>)." + rm.getMemberName());
                        }
                    }
                    // A watch resumes itself: the same request again (what it listens to included), from the last event.
                    String lastMember = input(r).getAllMembers().values().stream()
                        .filter(rm -> rm.getTrait(HttpHeaderTrait.class).map(h -> h.getValue().equalsIgnoreCase("Last-Event-ID")).orElse(false))
                        .map(MemberShape::getMemberName).findFirst().orElse("lastEventId");
                    // Once Last-Event-ID carries the position, a cursor the watch started from (`after`) is left out
                    // (PROTOCOL.md 5.6); before any event, the request goes as it was, with no Last-Event-ID.
                    boolean hasAfter = input(r).getMember("after").isPresent();
                    String resumeInput = r.getId().equals(op.getId())
                        ? commandInput.substring(0, commandInput.length() - 2)
                            + (hasAfter ? ", ...(lastEventId === undefined ? {} : { after: undefined })" : "")
                            + ", " + lastMember + ": lastEventId }"
                        : "{ " + String.join(", ", fields) + " }";
                    resume = "(lastEventId, streamSignal) =>\n      client.send(new " + r.getId().getName() + "Command(" + resumeInput
                        + "), { abortSignal: streamSignal })";
                }
                // A watch that resumes itself and takes no Last-Event-ID starts every connection with a snapshot
                // (WatchKnowledgeBase, PROTOCOL.md 16): it reconnects with no cursor.
                boolean fresh = resumeWith.isPresent() && resumeWith.get().equals(op.getId().toString())
                    && input(op).getAllMembers().values().stream().noneMatch(rm -> rm.getTrait(HttpHeaderTrait.class)
                        .map(h -> h.getValue().equalsIgnoreCase("Last-Event-ID")).orElse(false));
                if (fresh) resume = "(_lastEventId, streamSignal) =>\n      client.send(new " + opName + "Command(" + commandInput + "), { abortSignal: streamSignal })";
                // A watch that starts with a snapshot gives each event processingOf(): the watched thing's processing,
                // read from the snapshot and the progress events alike (PROTOCOL.md 16, watch.processing).
                boolean snapshots = union.getAllMembers().values().stream()
                    .anyMatch(um -> um.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(um.getMemberName()).equals("snapshot"));
                String decorate = "";
                if (snapshots) {
                    imports.add("import { withProcessing, type KnowledgeBaseWatchAccessor } from \"@caitlyn-ai/sdk-core\";\n");
                    events = "(" + events + " & KnowledgeBaseWatchAccessor)";
                    decorate = ", decorate: withProcessing(input as Record<string, any>)";
                }
                String names = union.getId().getName() + "Names";
                String readsName = union.getId().getName() + "Reads";
                reads.computeIfAbsent(union.getId(), id -> eventReads(union, schemaImports));
                // Attachments (PROTOCOL.md 16): a list of {uploadId} takes files too. Each is uploaded first, reserved for
                // the thing the call is on (UploadPurpose's member of the same name as a label, conversationId), in order;
                // the first that fails raises, and nothing is sent.
                Optional<MemberShape> attach = attachmentMember(op);
                // Every request the stream sends goes with its own signal (the caller's, and close()).
                String openExpr = "client.send(new " + opName + "Command(" + commandInput + "), { abortSignal: streamSignal })";
                String fnInputType = inputType;
                if (attach.isPresent()) {
                    String a = attach.get().getMemberName();
                    String purposeMember = purposeFor(op);
                    imports.add("import { uploadAttachments, type AttachmentInput } from \"@caitlyn-ai/sdk-core\";\n");
                    fnInputType = "Omit<" + inputType + ", \"" + a + "\"> & { " + a + "?: AttachmentInput[] }";
                    openExpr = "uploadAttachments(input." + a + ", (file) => sendUpload(client, file, { purpose: { " + purposeMember + ": input." + purposeMember
                        + " } }, { signal: streamSignal })).then((" + a + ") => client.send(new " + opName + "Command({ ...input, " + a + ", ...rest } as " + inputType + "), { abortSignal: streamSignal }))";
                }
                body.append("export function ").append(fn).append("(client: CaitlynClient, ").append(positionalParam)
                    .append("input: ").append(fnInputType).append(", ").append(optionsParam)
                    .append("): SseStream<").append(events).append(", ").append(finalType).append("> & AsyncDisposableStream {\n")
                    .append("  const { signal, ...rest } = options;\n")
                    .append("  return new SseStream<").append(events).append(", ").append(finalType).append(">(\n")
                    .append("    { known: ").append(names).append(", final: ").append(finalSpec)
                    .append(", errorEvent: ").append(errorEvent).append(", toError").append(fresh ? ", fresh: true" : "").append(decorate).append(", read: ").append(readsName).append(" },\n")
                    .append("    (streamSignal) => ").append(openExpr).append(",\n")
                    .append("    ").append(resume).append(",\n")
                    .append("    signal,\n  ) as SseStream<").append(events).append(", ").append(finalType).append("> & AsyncDisposableStream;\n}\n\n");
            } else if (page.isPresent()) {
                PaginationInfo info = page.get();
                MemberShape items = info.getItemsMemberPath().get(info.getItemsMemberPath().size() - 1);
                ListShape list = model.expectShape(items.getTarget(), ListShape.class);
                String item = typeName(list.getMember().getTarget());
                modelTypes.add(item);
                String pageSize = info.getPageSizeMember().map(MemberShape::getMemberName).orElse(null);
                imports.add("import { paginate" + opName + " } from \"../pagination/" + opName + "Paginator\";\n");
                body.append("export function ").append(fn).append("(client: CaitlynClient, ").append(positionalParam)
                    .append("input: ").append(inputType).append(", ").append(optionsParam)
                    .append("): AsyncIterable<WithRaw<").append(item).append(">> {\n")
                    .append("  const { signal, ...rest } = options;\n")
                    .append("  return {\n    async *[Symbol.asyncIterator]() {\n")
                    .append("      const pages = paginate").append(opName).append("({ client")
                    .append(pageSize != null ? ", pageSize: input." + pageSize : "").append(" }, ")
                    .append(commandInput).append(", { abortSignal: signal });\n")
                    .append("      for await (const page of pages) yield* page.").append(items.getMemberName())
                    .append(" as WithRaw<").append(item).append(">[];\n    },\n  };\n}\n\n");
            } else if (uploadTarget(op).isPresent()) {
                // @uploadTarget (PROTOCOL.md 10): the method takes a file in place of the identifier at the member's path,
                // uploads it (core.uploads.send, with the purpose the member's documentation names), then calls the
                // operation with the upload's id there.
                List<String> path = List.of(uploadTarget(op).get().split("\\."));
                String purpose = uploadPurpose(op, path).map(p -> "{ purpose: " + p + " }").orElse("{}");
                String fileInput = fileInputType(op, inputType, path);
                body.append("export async function ").append(fn).append("(client: CaitlynClient, ").append(positionalParam)
                    .append("input: ").append(fileInput).append(", ").append(optionsParam)
                    .append("): Promise<WithRaw<").append(out).append(" & __MetadataBearer>> {\n")
                    .append("  const { signal, ...rest } = options;\n")
                    .append("  const resolved = await resolveUploadTarget(input, ").append(path.stream().map(x -> "\"" + x + "\"").collect(Collectors.joining(", ", "[", "]")))
                    .append(", (file) => sendUpload(client, file, ").append(purpose).append(", { signal }));\n")
                    .append("  return client.send(new ").append(opName).append("Command({ ...(resolved as ").append(inputType).append(")")
                    .append(m.positional() != null ? ", " + m.positional() : "").append(", ...rest }), { abortSignal: signal })").append(unwrap).append(" as Promise<WithRaw<")
                    .append(out).append(" & __MetadataBearer>>;\n}\n\n");
            } else {
                body.append("export function ").append(fn).append("(client: CaitlynClient, ").append(positionalParam)
                    .append("input: ").append(inputType).append(", ").append(optionsParam)
                    .append("): Promise<WithRaw<").append(out).append(" & __MetadataBearer>> {\n")
                    .append("  const { signal, ...rest } = options;\n")
                    .append("  return client.send(new ").append(opName).append("Command(").append(commandInput)
                    .append("), { abortSignal: signal })").append(unwrap).append(" as Promise<WithRaw<").append(out).append(" & __MetadataBearer>>;\n}\n\n");
            }
            if (op.hasTrait(WAITABLE)) throw new CodegenException(op.getId() + ": waiters are replaced by wait() (PROTOCOL.md 16)");
            if (op.hasTrait(PRESIGNED_UPLOAD)) presigned = op;
        }

        // core.uploads.send(file) from @presignedUpload (PROTOCOL.md 10 and 14).
        boolean targets = methods.keySet().stream().anyMatch(o -> uploadTarget(o).isPresent());
        if (presigned == null && targets) throw new CodegenException("@uploadTarget needs an operation with @presignedUpload");
        if (presigned != null) {
            String fn = lowerCamel(presigned.getId().getName());
            String in = typeName(presigned.getInputShape());
            String out = resultType(presigned);
            imports.add("import { sendFile, resolveUploadTarget, type FileInput } from \"@caitlyn-ai/sdk-core\";\n");
            body.append("/**\n * Sends a file (PROTOCOL.md 14): hashes it, reserves an upload with ").append(presigned.getId().getName())
                .append(", then PUTs the bytes to the upload's URL\n * with exactly its requiredHeaders, retried; UPLOAD_PUT_FAILED when that still fails. Returns the upload, whose `id`\n")
                .append(" * an operation that uses it takes. `input` takes the reservation's other members (`purpose`).\n */\n")
                .append("export function sendUpload(client: CaitlynClient, file: FileInput, input: Omit<").append(in)
                .append(", \"fileName\" | \"contentType\" | \"byteSize\" | \"sha256\" | \"idempotencyKey\"> = {}, options: CallOptions & { idempotencyKey?: string } = {}): Promise<WithRaw<")
                .append(out).append(" & __MetadataBearer>> {\n")
                .append("  return sendFile(file, (meta) => ").append(fn).append("(client, { ...input, ...meta }, options), toError, storage(client, options.signal));\n}\n\n");
            modelTypes.add(out);
        }

        modelTypes.addAll(nestedTypes);
        imports.add(typeImports(modelTypes));
        if (!eventTypes.isEmpty()) {
            List<String> values = eventTypes.stream().filter(t -> t.endsWith("Names")).toList();
            List<String> types = eventTypes.stream().filter(t -> !t.endsWith("Names")).toList();
            imports.add("import { " + String.join(", ", values)
                + (types.isEmpty() ? "" : ", type " + String.join(", type ", types)) + " } from \"./events\";\n");
        }
        if (!reads.isEmpty()) {
            imports.add("import type { EventPlan } from \"@caitlyn-ai/sdk-core\";\n");
            if (!schemaImports.isEmpty()) imports.add("import { " + String.join(", ", schemaImports) + " } from \"../schemas/schemas_0\";\n");
        }
        StringBuilder plans = new StringBuilder();
        for (Map.Entry<ShapeId, String> e : reads.entrySet()) {
            plans.append("/** How each ").append(e.getKey().getName()).append(" is read: its members that are the model's types. */\n")
                .append("const ").append(e.getKey().getName()).append("Reads: Record<string, EventPlan> = ").append(e.getValue()).append(";\n\n");
        }
        return HEADER + String.join("", imports) + "\n" + plans + body;
    }

    // ------------------------------------------------------------------ client.ts and index.ts

    private String indexFile() {
        return HEADER
            + "// The public entry: model shapes, operations and the client. Command classes are not exported.\n"
            + "export * from \"./client\";\n"
            + "export * from \"./operations\";\n"
            + "export * from \"./events\";\n"
            + "export type * from \"../models/models_0\";\n"
            + "export type * from \"./results\";\n"
            + "export * from \"../models/enums\";\n"
            + "export * from \"../models/errors\";\n"
            + "export { CaitlynError } from \"./errors\";\n"
            + "export { CaitlynConnectionError } from \"./connection\";\n"
            + "export { NotSupportedByServer, SseStream, CaitlynAuthError, UploadFile, WorkPromise, contentTypeFor, createAuth, workspaceAudience, isSyncAborted, withHints, type FileInput, type UploadFileOptions, type UploadDescription, type BatchFiles, type BatchUpload, type BatchUploadOptions, type IngestionProgress, type SyncItemInput, type SyncOptions, type SyncPhase, type SyncPlan, type SyncReport, type SyncReportBatch, type SyncReportItem, type LocalFile, type ReadersShorthand, type WaitOptions, type AuthOptions, type AuthSession, type AwsCredentials, type OAuthTokens, type TokenStore, type CaitlynOptions, type CallOptions, type CaitlynErrorFields, type WithRaw } from \"@caitlyn-ai/sdk-core\";\n";
    }

    /**
     * CaitlynError: the generated base exception, typed with the fields every Caitlyn error carries (PROTOCOL.md
     * 6.3), so `catch (e) { if (e instanceof CaitlynError) e.code }` needs no cast. The fields are the model's
     * ProblemDetails members (the members every error shape shares) plus the three the SDK adds itself. They cannot be declared on the base class: the
     * generated error classes' constructor options omit every key the base class has.
     */
    private String errorBaseFile() {
        // The ProblemDetails mixin is flattened into each error shape by the time generators run, so its members
        // are the ones every error shape has (model lint rule 2 makes every error use the mixin).
        List<StructureShape> errorShapes = new ArrayList<>();
        Set<ShapeId> errorIds = new TreeSet<>(service.getErrorsSet());
        for (OperationShape op : operations()) errorIds.addAll(op.getErrorsSet());
        for (ShapeId id : errorIds) errorShapes.add(model.expectShape(id, StructureShape.class));
        if (errorShapes.isEmpty()) throw new IllegalStateException("The service has no error shapes");
        List<MemberShape> problem = errorShapes.get(0).getAllMembers().values().stream()
            .filter(m -> !m.hasTrait(HttpHeaderTrait.class))
            .filter(m -> errorShapes.stream().allMatch(e -> e.getMember(m.getMemberName())
                .map(o -> o.getTarget().equals(m.getTarget())).orElse(false)))
            .toList();
        // Always set, from the response or the SDK's own code; a body that is not problem details leaves the other
        // members empty (PROTOCOL.md 6.1), so they are optional here whatever the model says.
        Set<String> alwaysSet = Set.of("status", "code");
        Set<String> structures = new TreeSet<>();
        StringBuilder fields = new StringBuilder();
        for (MemberShape m : problem) {
            Shape target = model.expectShape(m.getTarget());
            if (target.isStructureShape()) structures.add(tsType(m.getTarget()));
            if (target instanceof ListShape l && model.expectShape(l.getMember().getTarget()).isStructureShape()) {
                structures.add(tsType(l.getMember().getTarget()));
            }
            fields.append(doc(m, "  ")).append("  ").append(m.getMemberName())
                .append(alwaysSet.contains(m.getMemberName()) ? ": " : "?: ").append(tsType(m.getTarget())).append(";\n");
        }
        fields.append("  /** `Retry-After` in seconds, on 429 and 503 responses. */\n  retryAfterSeconds?: number;\n")
            .append("  /** The response body as received, as text, at most its first 8 KiB: the only view of a body that is not problem details. */\n  rawBody?: string;\n")
            .append("  /** True when the body was longer than 8 KiB and `rawBody` holds only its first 8 KiB. */\n  rawBodyTruncated?: boolean;\n")
            .append("  /** On the `CANCELLED` error of a sync whose plan was not confirmed (PROTOCOL.md 15): its report, the batch and\n")
            .append("   * every item as read once it was cancelled. Undefined on every other error. */\n  report?: SyncReport;\n");
        return HEADER
            + "import type { SyncReport } from \"@caitlyn-ai/sdk-core\";\n"
            + "import { CaitlynServiceException, type __ServiceExceptionOptions } from \"../models/CaitlynServiceException\";\n"
            + (structures.isEmpty() ? "" : "import type { " + String.join(", ", structures) + " } from \"../models/models_0\";\n")
            + "\n/**\n * Every Caitlyn error: the typed classes (NotFoundError, ValidationError…) and the generic error for a status\n"
            + " * the model does not name. Generated from the model's ProblemDetails (PROTOCOL.md 6.3).\n */\n"
            + "export interface CaitlynError extends CaitlynServiceException {\n" + fields + "}\n\n"
            + "/** The base class of every Caitlyn error, for `instanceof`. */\n"
            + "export const CaitlynError: {\n  new (options: __ServiceExceptionOptions): CaitlynError;\n  readonly prototype: CaitlynError;\n}"
            + " = CaitlynServiceException as never;\n";
    }

    /** The connection error (PROTOCOL.md 6.5): a CaitlynError, so it extends the generated base exception. */
    private String connectionFile() {
        return HEADER
            + "import { CaitlynServiceException } from \"../models/CaitlynServiceException\";\n\n"
            + "/**\n"
            + " * No HTTP response arrived (the connection was refused or reset, DNS or TLS failed, or it timed out before\n"
            + " * the headers), or the connection failed while the body was read; raised once the retries are spent\n"
            + " * (PROTOCOL.md 6.5). It is a `CaitlynError` with `status` 0 and `code` `CONNECTION_ERROR`; `cause` is the\n"
            + " * network error.\n"
            + " */\n"
            + "export class CaitlynConnectionError extends CaitlynServiceException {\n"
            + "  readonly status = 0;\n"
            + "  readonly code = \"CONNECTION_ERROR\";\n"
            + "  readonly title: string;\n"
            + "  readonly requestId: string | undefined = undefined;\n"
            + "  readonly rawBody = \"\";\n"
            + "  readonly rawBodyTruncated = false;\n\n"
            + "  constructor(operation: string, cause: unknown) {\n"
            + "    const reason = cause instanceof Error ? cause.message : String(cause);\n"
            + "    super({ name: \"CaitlynConnectionError\", $fault: \"client\", $metadata: {}, message: `${operation}: no response: ${reason}` });\n"
            + "    Object.setPrototypeOf(this, CaitlynConnectionError.prototype);\n"
            + "    this.title = `${operation}: no response`;\n"
            + "    this.cause = cause;\n"
            + "  }\n"
            + "}\n";
    }

    /** The member path of an operation's @uploadTarget, if it has one. */
    static Optional<String> uploadTarget(OperationShape op) {
        return op.findTrait(UPLOAD_TARGET).map(t -> t.toNode().expectObjectNode().expectStringMember("member").getValue());
    }

    /** The member at an @uploadTarget path, checked against the model. */
    MemberShape targetMember(OperationShape op, List<String> path) {
        StructureShape s = input(op);
        MemberShape m = null;
        for (int i = 0; i < path.size(); i++) {
            String seg = path.get(i);
            m = s.getMember(seg).orElseThrow(() -> new CodegenException(op.getId() + ": @uploadTarget " + String.join(".", path) + ": no member " + seg));
            if (i < path.size() - 1) s = model.expectShape(m.getTarget(), StructureShape.class);
        }
        return m;
    }

    /**
     * The purpose an @uploadTarget member's documentation names for its upload, as a TypeScript literal: "reserved with
     * CreateUpload and `purpose: {agentAvatar: true}`" gives `{ agentAvatar: true }` (PROTOCOL.md 10).
     */
    private Optional<String> uploadPurpose(OperationShape op, List<String> path) {
        String text = targetMember(op, path).getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
        java.util.regex.Matcher mt = java.util.regex.Pattern.compile("`purpose: \\{(\\w+): true\\}`").matcher(text);
        return mt.find() ? Optional.of("{ " + mt.group(1) + ": true }") : Optional.empty();
    }

    /**
     * The input type of an @uploadTarget operation's method: a top-level identifier is replaced by `file` (either may
     * be given); a nested one takes a file or an identifier at its path.
     */
    String fileInputType(OperationShape op, String inputType, List<String> path) {
        MemberShape leaf = targetMember(op, path);
        if (path.size() == 1) {
            String member = path.get(0);
            boolean required = leaf.hasTrait(RequiredTrait.class);
            return "Omit<" + inputType + ", \"" + member + "\"> & ("
                + (required
                    ? "{ file: FileInput; " + member + "?: never } | { " + member + ": string; file?: never })"
                    : "{ file?: FileInput; " + member + "?: string })");
        }
        return nestedFileType(input(op), inputType, path, 0);
    }

    private String nestedFileType(StructureShape s, String typeExpr, List<String> path, int i) {
        String seg = path.get(i);
        MemberShape m = s.getMember(seg).orElseThrow();
        String opt = m.hasTrait(RequiredTrait.class) ? "" : "?";
        if (i < path.size() - 1) nestedTypes.add(typeName(m.getTarget()));
        String inner = i == path.size() - 1 ? "string | FileInput"
            : nestedFileType(model.expectShape(m.getTarget(), StructureShape.class), typeName(m.getTarget()), path, i + 1);
        return "Omit<" + typeExpr + ", \"" + seg + "\"> & { " + seg + opt + ": " + inner + " }";
    }

    /** The operations kb.ingestion.sync sends (PROTOCOL.md 15). */
    static final List<String> SYNC_OPERATIONS = List.of("CreateIngestionBatch", "BatchCreateIngestionBatchItems",
        "GetIngestionBatch", "ListIngestionBatchItems", "UpdateIngestionBatchItem", "StartIngestionBatch",
        "CreateIngestionBatchUploadPolicy", "CompleteIngestionBatchUploads", "CancelIngestionBatch", "ListDocuments", "EstimateIngestion");

    boolean hasSyncOperations() {
        Set<String> names = operations().stream().map(o -> o.getId().getName()).collect(Collectors.toSet());
        return names.containsAll(SYNC_OPERATIONS);
    }

    // ------------------------------------------------------------------ problems.ts

    /**
     * The typed error for problem details that arrive outside an HTTP error response (the SSE failure event, a failed
     * upload, a job's error): the class for its status (PROTOCOL.md 6.2), or for a job's error, which carries only a
     * code, the class whose errorCodes list it. Also the client's limits for bytes sent to storage. Internal to the SDK.
     */
    private String problemsFile() {
        Map<Integer, String> byStatus = new TreeMap<>();
        Map<String, String> byCode = new TreeMap<>();
        Set<ShapeId> errors = new TreeSet<>(service.getErrorsSet());
        for (OperationShape op : operations()) errors.addAll(op.getErrorsSet());
        for (ShapeId e : errors) {
            Shape shape = model.expectShape(e);
            shape.getTrait(software.amazon.smithy.model.traits.HttpErrorTrait.class).ifPresent(t -> byStatus.putIfAbsent(t.getCode(), e.getName()));
            ai.caitlyn.codegen.model.CaitlynTraits.node(shape, ai.caitlyn.codegen.model.CaitlynTraits.ERROR_CODES).ifPresent(n ->
                n.expectArrayNode().getElements().forEach(c -> byCode.putIfAbsent(c.expectStringNode().getValue(), e.getName())));
        }
        Map<String, Integer> statusOf = new TreeMap<>();
        byStatus.forEach((code, name) -> statusOf.putIfAbsent(name, code));
        StringBuilder out = new StringBuilder(HEADER)
            .append("import type { CaitlynClient } from \"../CaitlynClient\";\n")
            .append("import { CaitlynServiceException } from \"../models/CaitlynServiceException\";\n")
            .append("import type { SendOptions } from \"@caitlyn-ai/sdk-core\";\n");
        if (!byStatus.isEmpty()) out.append("import { ").append(String.join(", ", new TreeSet<>(byStatus.values()))).append(" } from \"../models/errors\";\n");
        out.append("\n/** The error class for each HTTP status (one per status: PROTOCOL.md lint rule 1). */\n")
            .append("const ERROR_CLASSES: Record<number, new (opts: any) => CaitlynServiceException> = {\n");
        byStatus.forEach((code, name) -> out.append("  ").append(code).append(": ").append(name).append(",\n"));
        out.append("};\n\n/** The HTTP status of each error code the model lists (errorCodes): a job's error carries only its code. */\n")
            .append("const STATUS_OF_CODE: Record<string, number> = {\n");
        byCode.forEach((code, name) -> out.append("  ").append(code).append(": ").append(statusOf.get(name)).append(",\n"));
        out.append("};\n\n")
            .append("/** Builds the typed error for problem details that arrive outside an HTTP error response. */\n")
            .append("export const toError = (problem: Record<string, unknown>): Error => {\n")
            .append("  const status = Number(problem.status ?? 0);\n")
            .append("  const fault = status >= 500 ? \"server\" : \"client\";\n")
            .append("  const message = String(problem.detail ?? problem.title ?? problem.code);\n")
            .append("  const Typed = ERROR_CLASSES[status];\n")
            .append("  const error = Typed\n")
            .append("    ? new Typed({ $fault: fault, $metadata: {}, message })\n")
            .append("    : new CaitlynServiceException({ name: \"CaitlynError\", $fault: fault, $metadata: {}, message });\n")
            .append("  return Object.assign(error, problem, { message });\n")
            .append("};\n\n")
            .append("/**\n * The typed error for a failed job's error ({code, detail}, PROTOCOL.md 16): the class whose errorCodes list the code,\n")
            .append(" * with that class's status; a code no class lists is the generic error, with status 0.\n */\n")
            .append("export const jobError = (error: Record<string, unknown>): Error =>\n")
            .append("  toError({ ...error, status: STATUS_OF_CODE[String(error.code)] ?? 0, title: String(error.detail ?? error.code) });\n\n")
            .append("/** The client's limits for the bytes file helpers send to storage, and its tracer (PROTOCOL.md 13). */\n")
            .append("export const storage = (client: CaitlynClient, signal?: AbortSignal): SendOptions => {\n")
            .append("  const c = client.config as { caitlynTracer?: SendOptions[\"tracer\"]; caitlynStorage?: { maxAttempts?: number; maxRetryDelayMs?: number } };\n")
            .append("  return { signal, tracer: c.caitlynTracer, ...c.caitlynStorage };\n};\n");
        return out.toString();
    }

    static final String HEADER = "// Generated by ai.caitlyn:caitlyn-typescript-codegen from the Smithy model. Do not edit.\n";
}
