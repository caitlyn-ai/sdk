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
            .append("    : new CaitlynServiceException({ name: String(problem.code ?? \"Error\"), $fault: fault, $metadata: {}, message });\n")
            .append("  return Object.assign(error, problem, { message });\n")
            .append("};\n\n");

        PaginatedIndex paginated = PaginatedIndex.of(model);
        OperationShape presigned = null;
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
                    resume = "async (lastEventId) =>\n      (await client.send(new " + r.getId().getName() + "Command({ "
                        + String.join(", ", fields) + " }), { abortSignal: signal })).events as unknown as AsyncIterable<Uint8Array>";
                }
                body.append("export function ").append(fn).append("(client: CaitlynClient, ").append(positionalParam)
                    .append("input: ").append(inputType).append(", ").append(optionsParam)
                    .append("): SseStream<").append(events).append(", ").append(finalType).append("> {\n")
                    .append("  const { signal, ...rest } = options;\n")
                    .append("  return new SseStream<").append(events).append(", ").append(finalType).append(">(\n")
                    .append("    { known: ").append(events).append("Names, final: ").append(finalSpec)
                    .append(", errorEvent: ").append(errorEvent).append(", toError },\n")
                    .append("    async () => (await client.send(new ").append(opName).append("Command(").append(commandInput)
                    .append("), { abortSignal: signal })).events as unknown as AsyncIterable<Uint8Array>,\n")
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
                .append("  return uploadFile(file, fileName, (meta) => ").append(fn).append("(client, { ...rest, ...meta }, options), toError, options.signal);\n}\n\n");
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
        if (!eventTypes.isEmpty()) {
            List<String> values = eventTypes.stream().filter(t -> t.endsWith("Names")).toList();
            List<String> types = eventTypes.stream().filter(t -> !t.endsWith("Names")).toList();
            imports.add("import { " + String.join(", ", values)
                + (types.isEmpty() ? "" : ", type " + String.join(", type ", types)) + " } from \"./events\";\n");
        }
        return HEADER + String.join("", imports) + "\n" + body;
    }

    // ------------------------------------------------------------------ client.ts and index.ts

    private String clientFile(Map<OperationShape, Method> methods) {
        Map<String, Map<String, String>> namespaces = new TreeMap<>();
        for (Map.Entry<OperationShape, Method> e : methods.entrySet()) {
            namespaces.computeIfAbsent(e.getValue().namespace(), k -> new TreeMap<>())
                .put(e.getValue().name(), lowerCamel(e.getKey().getId().getName()));
            if (e.getKey().hasTrait(PRESIGNED_UPLOAD)) {
                namespaces.get(e.getValue().namespace()).put("create", lowerCamel(e.getKey().getId().getName()) + "FromFile");
            }
            if (e.getKey().hasTrait(UPLOAD_TARGET)) {
                namespaces.get(e.getValue().namespace()).put("upload",
                    "upload" + e.getValue().resource().getId().getName().replaceFirst("Resource$", ""));
            }
        }
        StringBuilder out = new StringBuilder(HEADER)
            .append("import { CaitlynClient } from \"../CaitlynClient\";\n")
            .append("import { clientConfig, createAuth, getCaitlynAuthPlugin, getCaitlynTelemetryPlugin, type AuthSession, type CaitlynOptions } from \"@caitlyn-ai/sdk-core\";\n")
            .append("import * as ops from \"./operations\";\n\n")
            .append("type Rest<F> = F extends (client: CaitlynClient, ...rest: infer R) => unknown ? R : never;\n\n")
            .append("/** Creates the client the standalone operation functions take as their first argument. */\n")
            .append("export function createCaitlynClient(options: CaitlynOptions, auth: AuthSession = createAuth(options)): CaitlynClient {\n")
            .append("  const client = new CaitlynClient(clientConfig(options, auth));\n")
            .append("  client.middlewareStack.use(getCaitlynAuthPlugin(auth));\n")
            .append("  if (options.telemetry?.enabled !== false) client.middlewareStack.use(getCaitlynTelemetryPlugin(options.telemetry?.tracerProvider));\n")
            .append("  return client;\n}\n\n")
            .append("/** Every operation, grouped by namespace. Import the standalone functions instead for the smallest bundle. */\n")
            .append("export class ").append(service.getId().getName()).append(" {\n")
            .append("  readonly client: CaitlynClient;\n")
            .append("  /** The sign-in session: the current token, and the oauth mode's authorizationUrl(), handleCallback() and signOut(). */\n")
            .append("  readonly auth: AuthSession;\n\n")
            .append("  constructor(options: CaitlynOptions) {\n    this.auth = createAuth(options);\n    this.client = createCaitlynClient(options, this.auth);\n  }\n");
        for (Map.Entry<String, Map<String, String>> ns : namespaces.entrySet()) {
            out.append("\n  readonly ").append(ns.getKey()).append(" = {\n");
            for (Map.Entry<String, String> m : ns.getValue().entrySet()) {
                out.append("    ").append(m.getKey()).append(": (...args: Rest<typeof ops.").append(m.getValue())
                    .append(">) => ops.").append(m.getValue()).append("(this.client, ...args),\n");
            }
            out.append("  };\n");
        }
        return out.append("}\n").toString();
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
            + "export { CaitlynServiceException as CaitlynError } from \"../models/CaitlynServiceException\";\n"
            + "export { NotSupportedByServer, SseStream, CaitlynAuthError, WaiterError, createAuth, workspaceAudience, type AuthOptions, type AuthSession, type AwsCredentials, type OAuthTokens, type TokenStore, type CaitlynOptions, type CallOptions, type CaitlynErrorFields, type WaiterOptions, type WithRaw } from \"@caitlyn-ai/sdk-core\";\n";
    }

    private static final String HEADER = "// Generated by ai.caitlyn:caitlyn-typescript-codegen from the Smithy model. Do not edit.\n";
}
