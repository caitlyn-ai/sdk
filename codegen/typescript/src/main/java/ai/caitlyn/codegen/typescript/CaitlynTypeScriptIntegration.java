package ai.caitlyn.codegen.typescript;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import software.amazon.smithy.codegen.core.Symbol;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.typescript.codegen.LanguageTarget;
import software.amazon.smithy.typescript.codegen.TypeScriptSettings;
import software.amazon.smithy.typescript.codegen.TypeScriptWriter;
import software.amazon.smithy.typescript.codegen.integration.ProtocolGenerator;
import software.amazon.smithy.typescript.codegen.integration.RuntimeClientPlugin;
import software.amazon.smithy.typescript.codegen.integration.TypeScriptIntegration;
import software.amazon.smithy.typescript.codegen.schema.SchemaGenerationAllowlist;
import software.amazon.smithy.utils.MapUtils;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.neighbor.Walker;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.traits.IdempotencyTokenTrait;
import software.amazon.smithy.model.traits.IdempotentTrait;
import software.amazon.smithy.model.traits.ReadonlyTrait;
import java.util.ArrayList;
import java.util.Comparator;

/**
 * Wires Caitlyn's protocol and SDK identity into smithy-typescript, without smithy-aws-typescript-codegen.
 *
 * <ul>
 *   <li>Registers a protocol generator for {@code ai.caitlyn.protocols#restJson} and allows schema-based
 *       generation for it, so the client is generated in schema mode (no per-operation serde code).</li>
 *   <li>Sets the runtime {@code protocol} to {@code CaitlynRestJsonProtocol} from {@code @caitlyn-ai/sdk-core}.</li>
 *   <li>Adds {@code getCaitlynSdkPlugin}: the {@code caitlyn-sdk-ts/<version>} user agent, the model's API
 *       version header, and removal of Smithy's retry bookkeeping headers.</li>
 * </ul>
 *
 * <p>Because smithy-aws-typescript-codegen is not on the classpath, its user-agent, host-header,
 * recursion-detection and logger plugins, and its {@code @aws-sdk/core} imports, are never generated.
 */
public final class CaitlynTypeScriptIntegration implements TypeScriptIntegration {

    public static final ShapeId PROTOCOL = ShapeId.from("ai.caitlyn.protocols#restJson");

    static {
        SchemaGenerationAllowlist.allowProtocol(PROTOCOL);
    }

    @Override
    public void customize(software.amazon.smithy.typescript.codegen.TypeScriptCodegenContext context) {
        if (PROTOCOL.equals(context.settings().getProtocol())) {
            new FacadeGenerator(context).generate();
        }
    }

    @Override
    public List<String> runAfter() {
        return List.of("software.amazon.smithy.typescript.codegen.integration.AddClientRuntimeConfig");
    }

    @Override
    public List<ProtocolGenerator> getProtocolGenerators() {
        return List.of(new CaitlynRestJsonProtocolGenerator());
    }

    @Override
    public void addConfigInterfaceFields(
        TypeScriptSettings settings, Model model, SymbolProvider symbolProvider, TypeScriptWriter writer
    ) {
        writer.writeDocs("The SDK package version, sent in the user agent.\n@internal");
        writer.write("caitlynSdkVersion?: string;\n");
    }

    @Override
    public Map<String, Consumer<TypeScriptWriter>> getRuntimeConfigWriters(
        TypeScriptSettings settings, Model model, SymbolProvider symbolProvider, LanguageTarget target
    ) {
        if (!PROTOCOL.equals(settings.getProtocol())) {
            return Map.of();
        }
        if (target == LanguageTarget.NODE || target == LanguageTarget.BROWSER) {
            // smithy-typescript's defaults read AWS_MAX_ATTEMPTS, AWS_RETRY_MODE, AWS_DEFAULTS_MODE and
            // ~/.aws/config (through the "defaults mode" provider). Caitlyn clients take these from their own
            // options only; scripts/postgen-ts.mjs then removes the now-unused defaults-mode lines.
            return MapUtils.of(
                "maxAttempts", writer -> writer.write("3"),
                "retryMode", writer -> writer.write("$S", "standard"),
                // Every runtime, Node included, sends requests with the platform's fetch (decided 13 November 2026):
                // sdk-core's runtime has its own fetch handler, and @smithy/node-http-handler would bring
                // @smithy/core's protocol, serde and event-stream modules into a Node bundle.
                "requestHandler", writer -> {
                    writer.addImport("FetchHttpHandler", "RequestHandler",
                        software.amazon.smithy.typescript.codegen.TypeScriptDependency.AWS_SDK_FETCH_HTTP_HANDLER);
                    writer.write("RequestHandler.create(config?.requestHandler ?? (async () => undefined))");
                },
                "streamCollector", writer -> {
                    writer.addImport("streamCollector", null,
                        software.amazon.smithy.typescript.codegen.TypeScriptDependency.AWS_SDK_FETCH_HTTP_HANDLER);
                    writer.write("streamCollector");
                }
            );
        }
        if (target != LanguageTarget.SHARED) {
            return Map.of();
        }
        String namespace = settings.getService().getNamespace();
        return MapUtils.of(
            "protocol", writer -> {
                writer.addImport("CaitlynRestJsonProtocol", null, SdkCoreDependency.INSTANCE);
                writer.write("CaitlynRestJsonProtocol");
            },
            "protocolSettings", writer -> {
                writer.addRelativeImport("errorTypeRegistries", null,
                    java.nio.file.Paths.get(".", "src", "schemas", "schemas_0"));
                writer.write("{ defaultNamespace: $S, errorTypeRegistries }", namespace);
            },
            "caitlynSdkVersion", writer -> writer.write("$S", settings.getPackageVersion()),
            // A workspace has one fixed URL: no endpoint rules engine.
            "endpointProvider", writer -> {
                writer.addImport("caitlynEndpointProvider", null, SdkCoreDependency.INSTANCE);
                writer.write("caitlynEndpointProvider");
            },
            // Nothing in the Caitlyn API uses request checksums.
            "sha256", writer -> writer.write("undefined as any"),
            "retryStrategy", writer -> {
                writer.addImport("CaitlynRetryStrategy", null, SdkCoreDependency.INSTANCE);
                writer.write("new CaitlynRetryStrategy(config?.maxAttempts ?? 3)");
            }
        );
    }

    @Override
    public List<RuntimeClientPlugin> getClientPlugins() {
        Symbol plugin = Symbol.builder()
            .name("getCaitlynSdkPlugin")
            .namespace(SdkCoreDependency.PACKAGE, "/")
            .addDependency(SdkCoreDependency.INSTANCE.getDependencies().get(0))
            .build();
        return List.of(
            RuntimeClientPlugin.builder()
                .pluginFunction(plugin, (model, service, operation) -> Map.of(
                    "sdkModel", highestSince(model, service),
                    "retrySafeOperations", retrySafeOperations(model, service),
                    "since", sinceEntries(model, service)))
                .servicePredicate((model, service) -> service.hasTrait(PROTOCOL))
                .build()
        );
    }

    private static final ShapeId SINCE = ShapeId.from("ai.caitlyn.traits#since");

    /** The highest @since anywhere in the service: the server release the SDK was generated against. */
    static String highestSince(Model model, ServiceShape service) {
        Comparator<String> semver = Comparator.comparing((String v) -> {
            String[] p = v.split("\\.");
            return String.format("%08d%08d%08d", Integer.parseInt(p[0]), Integer.parseInt(p[1]), Integer.parseInt(p[2]));
        });
        return new Walker(model).walkShapes(service).stream()
            .flatMap(shape -> shape.findTrait(SINCE).stream())
            .map(t -> t.toNode().expectStringNode().getValue())
            .max(semver)
            .orElse(service.getVersion());
    }

    /** Operations that are @readonly, @idempotent, or have an @idempotencyToken input member. */
    static List<String> retrySafeOperations(Model model, ServiceShape service) {
        List<String> safe = new ArrayList<>();
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            boolean token = op.getInput()
                .flatMap(model::getShape)
                .flatMap(Shape::asStructureShape)
                .map(input -> input.members().stream().anyMatch(m -> m.hasTrait(IdempotencyTokenTrait.class)))
                .orElse(false);
            if (op.hasTrait(ReadonlyTrait.class) || op.hasTrait(IdempotentTrait.class) || token) {
                safe.add(op.getId().getName(service));
            }
        }
        safe.sort(String::compareTo);
        return safe;
    }

    /** "Operation=5.120.0" and "Operation.member=5.124.0" entries, for the runtime @since check. */
    static List<String> sinceEntries(Model model, ServiceShape service) {
        List<String> out = new ArrayList<>();
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            String name = op.getId().getName(service);
            op.findTrait(SINCE).ifPresent(t -> out.add(name + "=" + t.toNode().expectStringNode().getValue()));
            model.getShape(op.getInputShape()).flatMap(Shape::asStructureShape).ifPresent(input -> input.getAllMembers().values().forEach(m ->
                m.findTrait(SINCE).ifPresent(t ->
                    out.add(name + "." + m.getMemberName() + "=" + t.toNode().expectStringNode().getValue()))));
        }
        out.sort(String::compareTo);
        return out;
    }
}
