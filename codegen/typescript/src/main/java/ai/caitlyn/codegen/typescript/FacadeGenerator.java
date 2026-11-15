package ai.caitlyn.codegen.typescript;

import ai.caitlyn.codegen.model.ClientMethod;
import ai.caitlyn.codegen.model.SseEvents;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
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
    private final SseEvents sseEvents;

    private record Method(String namespace, String name, String positional, ResourceShape resource) {}

    /** smithy.waiters#waitable: an operation's waiters, by name. */
    private static final ShapeId WAITABLE = ShapeId.from("smithy.waiters#waitable");

    /** The waiter functions of an operation's waiters, in waiter-name order: Indexed gives waitUntilIndexed. */
    private static List<String> waiterFunctions(OperationShape op) {
        return op.findTrait(WAITABLE).map(t -> new TreeMap<>(t.toNode().expectObjectNode().getStringMap()).keySet().stream()
            .map(name -> "waitUntil" + name).toList()).orElse(List.of());
    }

    FacadeGenerator(TypeScriptCodegenContext context) {
        this.context = context;
        this.model = context.model();
        this.service = context.settings().getService(model);
        this.sseEvents = new SseEvents(model, service);
        // Shapes smithy-typescript generates: everything operations reach (not trait references).
        for (OperationShape op : operations()) {
            new Walker(model).walkShapes(op).forEach(s -> modelled.add(s.getId()));
        }
    }

    private List<OperationShape> operations() {
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
        context.fileManifest().writeFile("src/sdk/operations.ts", operationsFile(methods));
        context.fileManifest().writeFile("src/sdk/client.ts", clientFile(methods));
        context.fileManifest().writeFile("src/sdk/connection.ts", connectionFile());
        context.fileManifest().writeFile("src/sdk/errors.ts", errorBaseFile());
        context.fileManifest().writeFile("src/sdk/index.ts", indexFile());
    }

    // ------------------------------------------------------------------ naming

    private Method methodFor(OperationShape op) {
        // Shared with the Python and Go generators (model-support's ClientMethod, PROTOCOL.md section 10).
        ClientMethod cm = ClientMethod.of(model, op);
        return new Method(cm.namespace(), cm.method(), cm.positionalMember().orElse(null), cm.resource().orElse(null));
    }

    private static String lowerCamel(String s) {
        return Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    private String typeName(ShapeId id) {
        return context.symbolProvider().toSymbol(model.expectShape(id)).getName();
    }

    private StructureShape input(OperationShape op) {
        return model.expectShape(op.getInputShape(), StructureShape.class);
    }

    /** Input members passed as call options rather than input fields: If-Match and idempotency tokens. */
    private List<MemberShape> optionMembers(OperationShape op) {
        return input(op).getAllMembers().values().stream()
            .filter(m -> m.hasTrait(IdempotencyTokenTrait.class)
                || m.getTrait(HttpHeaderTrait.class).map(h -> h.getValue().equalsIgnoreCase("If-Match")).orElse(false))
            .toList();
    }

    private static String doc(Shape shape, String indent) {
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
        if (!imported.isEmpty()) {
            out.append("import type { ")
                .append(imported.stream().map(this::typeName).collect(Collectors.joining(", ")))
                .append(" } from \"../models/models_0\";\n\n");
        }
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

    /** TypeScript type of a shape as it appears in parsed SSE JSON (timestamps stay RFC 3339 strings). */
    private String tsType(ShapeId target) {
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
        Set<String> modelTypes = new TreeSet<>();
        Set<String> eventTypes = new TreeSet<>();
        imports.add("import type { CaitlynClient } from \"../CaitlynClient\";\n");
        imports.add("import { CaitlynServiceException } from \"../models/CaitlynServiceException\";\n");
        imports.add("import { SseStream, uploadFile, type CallOptions, type WithRaw } from \"@caitlyn-ai/sdk-core\";\n");
        // A single call's output carries the response metadata (HTTP status, request id), as the command's does.
        imports.add("import type { MetadataBearer as __MetadataBearer } from \"@smithy/types\";\n");

        // PROTOCOL.md 5.5 and 6.2: problem details that arrive outside an HTTP error response (the SSE failure
        // event, a failed upload) raise the same class an error response with that status would.
        Map<Integer, String> byStatus = new TreeMap<>();
        for (ShapeId e : service.getErrorsSet()) {
            model.expectShape(e).getTrait(software.amazon.smithy.model.traits.HttpErrorTrait.class)
                .ifPresent(t -> byStatus.putIfAbsent(t.getCode(), e.getName()));
        }
        for (OperationShape op : operations()) {
            for (ShapeId e : op.getErrorsSet()) {
                model.expectShape(e).getTrait(software.amazon.smithy.model.traits.HttpErrorTrait.class)
                    .ifPresent(t -> byStatus.putIfAbsent(t.getCode(), e.getName()));
            }
        }
        if (!byStatus.isEmpty()) {
            imports.add("import { " + String.join(", ", new TreeSet<>(byStatus.values())) + " } from \"../models/errors\";\n");
        }
        body.append("/** The error class for each HTTP status (one per status: PROTOCOL.md lint rule 1). */\n")
            .append("const ERROR_CLASSES: Record<number, new (opts: any) => CaitlynServiceException> = {\n");
        byStatus.forEach((code, name) -> body.append("  ").append(code).append(": ").append(name).append(",\n"));
        body.append("};\n\n")
            .append("/** Builds the typed error for problem details that arrive outside an HTTP error response. */\n")
            .append("const toError = (problem: Record<string, unknown>): Error => {\n")
            .append("  const status = Number(problem.status ?? 0);\n")
            .append("  const fault = status >= 500 ? \"server\" : \"client\";\n")
            .append("  const message = String(problem.detail ?? problem.title ?? problem.code);\n")
            .append("  const Typed = ERROR_CLASSES[status];\n")
            .append("  const error = Typed\n")
            .append("    ? new Typed({ $fault: fault, $metadata: {}, message })\n")
            .append("    : new CaitlynServiceException({ name: \"CaitlynError\", $fault: fault, $metadata: {}, message });\n")
            .append("  return Object.assign(error, problem, { message });\n")
            .append("};\n\n");

        PaginatedIndex paginated = PaginatedIndex.of(model);
        OperationShape presigned = null;
        Set<String> waiterImports = new TreeSet<>(); // error classes the waiters match that ERROR_CLASSES does not import
        for (OperationShape op : methods.keySet()) {
            String opName = op.getId().getName();
            String fn = lowerCamel(opName);
            Method m = methods.get(op);
            String in = typeName(op.getInputShape());
            String out = typeName(op.getOutputShape());
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
                                : rm.getMemberName() + ": (input as Record<string, string>)." + rm.getMemberName());
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
                    resume = "(lastEventId) =>\n      client.send(new " + r.getId().getName() + "Command(" + resumeInput
                        + "), { abortSignal: signal })";
                }
                body.append("export function ").append(fn).append("(client: CaitlynClient, ").append(positionalParam)
                    .append("input: ").append(inputType).append(", ").append(optionsParam)
                    .append("): SseStream<").append(events).append(", ").append(finalType).append("> {\n")
                    .append("  const { signal, ...rest } = options;\n")
                    .append("  return new SseStream<").append(events).append(", ").append(finalType).append(">(\n")
                    .append("    { known: ").append(events).append("Names, final: ").append(finalSpec)
                    .append(", errorEvent: ").append(errorEvent).append(", toError },\n")
                    .append("    () => client.send(new ").append(opName).append("Command(").append(commandInput)
                    .append("), { abortSignal: signal }),\n")
                    .append("    ").append(resume).append(",\n")
                    .append("    signal,\n  );\n}\n\n");
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
            } else {
                body.append("export function ").append(fn).append("(client: CaitlynClient, ").append(positionalParam)
                    .append("input: ").append(inputType).append(", ").append(optionsParam)
                    .append("): Promise<WithRaw<").append(out).append(" & __MetadataBearer>> {\n")
                    .append("  const { signal, ...rest } = options;\n")
                    .append("  return client.send(new ").append(opName).append("Command(").append(commandInput)
                    .append("), { abortSignal: signal }) as Promise<WithRaw<").append(out).append(" & __MetadataBearer>>;\n}\n\n");
                if (op.hasTrait(WAITABLE)) {
                    waiters(body, op, fn, positionalParam, m.positional(), inputType, out, byStatus, waiterImports);
                }
            }
            if (op.hasTrait(WAITABLE) && (sse.isPresent() || page.isPresent())) {
                throw new CodegenException(op.getId() + ": waiters on list or stream operations are not supported yet");
            }
            if (op.hasTrait(PRESIGNED_UPLOAD)) presigned = op;
        }

        // Upload helpers from @presignedUpload and @uploadTarget.
        if (presigned != null) {
            String fn = lowerCamel(presigned.getId().getName());
            String in = typeName(presigned.getInputShape());
            body.append("/** Computes the SHA-256, reserves the upload slot and sends the bytes to it. */\n")
                .append("export function ").append(fn).append("FromFile(client: CaitlynClient, input: { file: Blob; fileName: string } & Omit<")
                .append(in).append(", \"fileName\" | \"contentType\" | \"byteSize\" | \"sha256\" | \"idempotencyKey\">, options: CallOptions & { idempotencyKey?: string } = {}) {\n")
                .append("  const { file, fileName, ...rest } = input;\n")
                .append("  return uploadFile(file, fileName, (meta) => ").append(fn).append("(client, { ...rest, ...meta }, options), toError, options.signal,\n")
                .append("    (client.config as { caitlynTracer?: Parameters<typeof uploadFile>[5] }).caitlynTracer);\n}\n\n");
            for (OperationShape op : methods.keySet()) {
                Optional<String> member = op.findTrait(UPLOAD_TARGET)
                    .map(t -> t.toNode().expectObjectNode().expectStringMember("member").getValue());
                if (member.isEmpty()) continue;
                String target = lowerCamel(op.getId().getName());
                String tin = typeName(op.getInputShape());
                String helper = "upload" + methods.get(op).resource().getId().getName().replaceFirst("Resource$", "");
                body.append("/** Uploads the file, then calls ").append(target).append(" with the upload. */\n")
                    .append("export async function ").append(helper).append("(client: CaitlynClient, input: { file: Blob; fileName: string } & Omit<")
                    .append(tin).append(", \"").append(member.get()).append("\" | \"idempotencyKey\">, options: CallOptions & { idempotencyKey?: string } = {}) {\n")
                    .append("  const { file, fileName, ...rest } = input;\n")
                    .append("  const upload = await ").append(fn).append("FromFile(client, { file, fileName }, { signal: options.signal });\n")
                    .append("  return ").append(target).append("(client, { ...rest, ").append(member.get()).append(": upload.id }, options);\n}\n\n");
            }
        }

        imports.add("import type { " + String.join(", ", modelTypes) + " } from \"../models/models_0\";\n");
        if (methods.keySet().stream().anyMatch(o -> o.hasTrait(WAITABLE))) {
            imports.add("import { waitUntil, type WaiterOptions, type WaiterState } from \"@caitlyn-ai/sdk-core\";\n");
        }
        if (!waiterImports.isEmpty()) {
            imports.add("import { " + String.join(", ", waiterImports) + " } from \"../models/errors\";\n");
        }
        if (!eventTypes.isEmpty()) {
            List<String> values = eventTypes.stream().filter(t -> t.endsWith("Names")).toList();
            List<String> types = eventTypes.stream().filter(t -> !t.endsWith("Names")).toList();
            imports.add("import { " + String.join(", ", values)
                + (types.isEmpty() ? "" : ", type " + String.join(", type ", types)) + " } from \"./events\";\n");
        }
        return HEADER + String.join("", imports) + "\n" + body;
    }

    // ------------------------------------------------------------------ client.ts and index.ts

    /**
     * The waiters of an operation (smithy.waiters#waitable, PROTOCOL.md 10.1): waitUntil<Name>(), which polls the
     * operation through sdk-core's waitUntil with the waiter's delays and its default limit (its @waitLimits entry,
     * or five minutes). The acceptors are those the Go SDK supports: success, errorType, and an output path (field
     * chains with at most one [] projection) compared with stringEquals or booleanEquals, or allStringEquals or
     * anyStringEquals on a projection. Paths and error types are checked against the model, so a wrong one fails
     * generation, not a wait.
     */
    private void waiters(StringBuilder body, OperationShape op, String fn, String positionalParam, String positional,
                         String inputType, String out, Map<Integer, String> byStatus, Set<String> waiterImports) {
        StructureShape output = model.expectShape(op.getOutputShape(), StructureShape.class);
        Map<String, Node> waiters = new TreeMap<>(op.findTrait(WAITABLE).orElseThrow().toNode().expectObjectNode().getStringMap());
        for (Map.Entry<String, Node> e : waiters.entrySet()) {
            String name = e.getKey();
            ObjectNode waiter = e.getValue().expectObjectNode();
            int min = waiter.getNumberMemberOrDefault("minDelay", 2).intValue();
            int max = waiter.getNumberMemberOrDefault("maxDelay", 120).intValue();
            int limit = ai.caitlyn.codegen.model.CaitlynTraits.waitLimitSeconds(op, name);
            String text = waiter.getStringMemberOrDefault("documentation", "Waits for " + name + ".");
            String accept = "accept" + name;
            String readArgs = "client, " + (positional != null ? positional + ", " : "") + "input, { signal }";
            // A waiter that succeeds only on an error (Deleted, on NotFoundError) has no output to return; one that mixes
            // output and error successes is refused (PROTOCOL.md 10.1).
            boolean onError = ai.caitlyn.codegen.model.Waiters.succeedsOnError(op.getId(), name, waiter);
            String returns = onError ? "Promise<void>" : "Promise<WithRaw<" + out + " & __MetadataBearer>>";
            String call = "waitUntil(\"waitUntil" + name + "\", (signal) => " + fn + "(" + readArgs + "), " + accept
                + ", { minDelayMs: " + (min * 1000) + ", maxDelayMs: " + (max * 1000) + ", ...options }, " + ((long) limit * 1000) + ")";
            body.append("/** ").append(text.replace("*/", "*\\/").replace("\n", "\n * ")).append("\n *\n * It reads ")
                .append(op.getId().getName()).append(" at once, then every ").append(min).append(" to ").append(max)
                .append(onError
                    ? " seconds, until a success state (it returns nothing: the error it waits for is the success), a failure\n * state, or an error the waiter"
                    : " seconds, until a success state (it returns that output), a failure state, or an error the waiter")
                .append(onError ? " " : "\n * ").append("does not expect (a WaiterError). It waits at most ").append(limit)
                .append(" seconds unless `maxWaitMs` says otherwise; `signal` cancels it. */\n")
                .append("export ").append(onError ? "async " : "").append("function waitUntil").append(name).append("(client: CaitlynClient, ")
                .append(positionalParam).append("input: ").append(inputType).append(", options: WaiterOptions = {}): ").append(returns).append(" {\n")
                .append(onError ? "  await " + call + ";\n}\n\n" : "  return " + call + ";\n}\n\n");

            StringBuilder acc = new StringBuilder("const ").append(accept).append(" = ({ output, error }: { output?: ").append(out)
                .append("; error?: unknown }): WaiterState | undefined => {\n");
            for (Node a : waiter.expectArrayMember("acceptors").getElements()) {
                ObjectNode acceptor = a.expectObjectNode();
                String state = acceptor.expectStringMember("state").getValue();
                if (!List.of("success", "failure", "retry").contains(state)) throw new CodegenException(op.getId() + ": unknown waiter state " + state);
                ObjectNode matcher = acceptor.expectObjectMember("matcher");
                String cond;
                if (matcher.getBooleanMember("success").isPresent()) {
                    cond = matcher.expectBooleanMember("success").getValue() ? "output !== undefined" : "error !== undefined";
                } else if (matcher.getStringMember("errorType").isPresent()) {
                    String type = matcher.expectStringMember("errorType").getValue();
                    boolean declared = java.util.stream.Stream.concat(op.getErrorsSet().stream(), service.getErrorsSet().stream())
                        .anyMatch(id -> id.getName().equals(type));
                    if (!declared) throw new CodegenException(op.getId() + ": waiter errorType " + type + " is not an error of the operation");
                    if (!byStatus.containsValue(type)) waiterImports.add(type);
                    cond = "error instanceof " + type;
                } else if (matcher.getObjectMember("output").isPresent()) {
                    ObjectNode o = matcher.expectObjectMember("output");
                    cond = "output !== undefined && " + pathCondition(op, output, o.expectStringMember("path").getValue(),
                        o.expectStringMember("comparator").getValue(), o.expectStringMember("expected").getValue());
                } else {
                    throw new CodegenException(op.getId() + ": only success, errorType and output waiter matchers are supported yet");
                }
                acc.append("  if (").append(cond).append(") return \"").append(state).append("\";\n");
            }
            // PROTOCOL.md 10.1: an output no acceptor matches polls again; an error no acceptor matches ends the wait.
            acc.append("  return error === undefined ? \"retry\" : undefined;\n};\n\n");
            body.append(acc);
        }
    }

    /** A waiter's output path as a TypeScript condition on `output`, checked against the model. */
    private String pathCondition(OperationShape op, StructureShape root, String path, String comparator, String expected) {
        if (!path.matches("[A-Za-z0-9_]+(\\[\\])?(\\.[A-Za-z0-9_]+(\\[\\])?)*") || path.chars().filter(ch -> ch == '[').count() > 1) {
            throw new CodegenException(op.getId() + ": waiter path " + path + " uses JMESPath beyond field chains and one [] projection");
        }
        Shape current = root;
        String before = "output";   // the expression up to the projection
        String after = "";          // the expression inside the projection, from its item `item`
        boolean projected = false;
        for (String raw : path.split("\\.")) {
            boolean flatten = raw.endsWith("[]");
            String seg = flatten ? raw.substring(0, raw.length() - 2) : raw;
            if (!(current instanceof StructureShape st)) throw new CodegenException(op.getId() + ": waiter path " + path + " walks into a non-structure");
            MemberShape m = st.getMember(seg).orElseThrow(() -> new CodegenException(op.getId() + ": waiter path " + path + ": no member " + seg));
            String key = m.getMemberName();
            // `output` itself is checked first (output !== undefined), so only the members after it may be absent.
            if (projected) after += "?." + key; else before += (before.equals("output") ? "." : "?.") + key;
            current = model.expectShape(m.getTarget());
            if (flatten) {
                if (!(current instanceof ListShape list)) throw new CodegenException(op.getId() + ": waiter path " + path + ": [] on a non-list");
                current = model.expectShape(list.getMember().getTarget());
                projected = true;
            }
        }
        if (!(current.isStringShape() || current.isEnumShape() || current.isBooleanShape())) {
            throw new CodegenException(op.getId() + ": waiter path " + path + " ends on " + current.getType());
        }
        String value = current.isBooleanShape() ? expected : "\"" + expected.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        if (current.isBooleanShape() && !expected.equals("true") && !expected.equals("false")) {
            throw new CodegenException(op.getId() + ": waiter path " + path + " expects " + expected + ", not a boolean");
        }
        if (projected) {
            String values = "(" + before + " ?? []).map((item) => item" + after + ")";
            return switch (comparator) {
                case "anyStringEquals" -> values + ".some((v) => v === " + value + ")";
                case "allStringEquals" -> "((vs) => vs.length > 0 && vs.every((v) => v === " + value + "))(" + values + ")";
                default -> throw new CodegenException(op.getId() + ": comparator " + comparator + " on a projection");
            };
        }
        return switch (comparator) {
            case "stringEquals", "booleanEquals" -> before + " === " + value;
            default -> throw new CodegenException(op.getId() + ": comparator " + comparator + " without a projection");
        };
    }

    /** One client object: its methods (name to operation function) and the objects nested in it. */
    private static final class Namespace {
        final Map<String, String> methods = new TreeMap<>();
        final Map<String, Namespace> children = new TreeMap<>();
    }

    private String clientFile(Map<OperationShape, Method> methods) {
        // A namespace may be a dotted path, outermost first (PROTOCOL.md 10): agents.versions nests a versions
        // object in agents, so caitlyn.agents.versions.get(…).
        Namespace root = new Namespace();
        for (Map.Entry<OperationShape, Method> e : methods.entrySet()) {
            Namespace ns = root;
            for (String segment : e.getValue().namespace().split("\\.")) {
                ns = ns.children.computeIfAbsent(segment, k -> new Namespace());
            }
            ns.methods.put(e.getValue().name(), lowerCamel(e.getKey().getId().getName()));
            for (String waiter : waiterFunctions(e.getKey())) ns.methods.put(waiter, waiter);
            if (e.getKey().hasTrait(PRESIGNED_UPLOAD)) {
                ns.methods.put("create", lowerCamel(e.getKey().getId().getName()) + "FromFile");
            }
            if (e.getKey().hasTrait(UPLOAD_TARGET)) {
                ns.methods.put("upload", "upload" + e.getValue().resource().getId().getName().replaceFirst("Resource$", ""));
            }
        }
        StringBuilder out = new StringBuilder(HEADER)
            .append("import { CaitlynClient } from \"../CaitlynClient\";\n")
            .append("import { clientConfig, createAuth, getCaitlynAuthPlugin, getCaitlynConnectionErrorPlugin, getCaitlynTelemetryPlugin, type AuthSession, type CaitlynOptions } from \"@caitlyn-ai/sdk-core\";\n")
            .append("import { CaitlynConnectionError } from \"./connection\";\n")
            .append("import * as ops from \"./operations\";\n\n")
            .append("type Rest<F> = F extends (client: CaitlynClient, ...rest: infer R) => unknown ? R : never;\n\n")
            .append("/** Creates the client the standalone operation functions take as their first argument. */\n")
            .append("export function createCaitlynClient(options: CaitlynOptions, auth: AuthSession = createAuth(options)): CaitlynClient {\n")
            .append("  const client = new CaitlynClient(clientConfig(options, auth));\n")
            .append("  client.middlewareStack.use(getCaitlynAuthPlugin(auth));\n")
            .append("  if (options.telemetry?.enabled !== false) client.middlewareStack.use(getCaitlynTelemetryPlugin(options.telemetry?.tracerProvider));\n")
            .append("  client.middlewareStack.use(getCaitlynConnectionErrorPlugin((operation, cause) => new CaitlynConnectionError(operation, cause)));\n")
            .append("  return client;\n}\n\n")
            .append("/** Every operation, grouped by namespace. Import the standalone functions instead for the smallest bundle. */\n")
            .append("export class ").append(service.getId().getName()).append(" {\n")
            .append("  readonly client: CaitlynClient;\n")
            .append("  /** The sign-in session: the current token, and the oauth mode's authorizationUrl(), handleCallback() and signOut(). */\n")
            .append("  readonly auth: AuthSession;\n\n")
            .append("  constructor(options: CaitlynOptions) {\n    this.auth = createAuth(options);\n    this.client = createCaitlynClient(options, this.auth);\n  }\n");
        for (Map.Entry<String, Namespace> ns : root.children.entrySet()) {
            out.append("\n  readonly ").append(ns.getKey()).append(" = ");
            namespaceObject(out, ns.getKey(), ns.getValue(), "  ");
            out.append(";\n");
        }
        return out.append("}\n").toString();
    }

    /** A namespace as an object literal: its methods, then its nested namespaces, each in name order. */
    private static void namespaceObject(StringBuilder out, String path, Namespace ns, String indent) {
        out.append("{\n");
        for (Map.Entry<String, String> m : ns.methods.entrySet()) {
            if (ns.children.containsKey(m.getKey())) {
                throw new CodegenException(path + "." + m.getKey() + " is both a method and a namespace");
            }
            out.append(indent).append("  ").append(m.getKey()).append(": (...args: Rest<typeof ops.").append(m.getValue())
                .append(">) => ops.").append(m.getValue()).append("(this.client, ...args),\n");
        }
        for (Map.Entry<String, Namespace> child : ns.children.entrySet()) {
            out.append(indent).append("  ").append(child.getKey()).append(": ");
            namespaceObject(out, path + "." + child.getKey(), child.getValue(), indent + "  ");
            out.append(",\n");
        }
        out.append(indent).append("}");
    }

    private String indexFile() {
        return HEADER
            + "// The public entry: model shapes, operations and the client. Command classes are not exported.\n"
            + "export { " + service.getId().getName() + ", createCaitlynClient } from \"./client\";\n"
            + "export * from \"./operations\";\n"
            + "export * from \"./events\";\n"
            + "export type * from \"../models/models_0\";\n"
            + "export * from \"../models/enums\";\n"
            + "export * from \"../models/errors\";\n"
            + "export { CaitlynError } from \"./errors\";\n"
            + "export { CaitlynConnectionError } from \"./connection\";\n"
            + "export { NotSupportedByServer, SseStream, CaitlynAuthError, WaiterError, createAuth, workspaceAudience, type AuthOptions, type AuthSession, type AwsCredentials, type OAuthTokens, type TokenStore, type CaitlynOptions, type CallOptions, type CaitlynErrorFields, type WaiterOptions, type WithRaw } from \"@caitlyn-ai/sdk-core\";\n";
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
            .append("  /** True when the body was longer than 8 KiB and `rawBody` holds only its first 8 KiB. */\n  rawBodyTruncated?: boolean;\n");
        return HEADER
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

    private static final String HEADER = "// Generated by ai.caitlyn:caitlyn-typescript-codegen from the Smithy model. Do not edit.\n";
}
