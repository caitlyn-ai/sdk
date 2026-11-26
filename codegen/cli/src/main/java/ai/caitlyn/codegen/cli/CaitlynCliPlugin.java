package ai.caitlyn.codegen.cli;

import ai.caitlyn.codegen.model.CaitlynTraits;

import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.build.SmithyBuildPlugin;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;

/**
 * smithy-build plugin {@code caitlyn-cli-codegen}: writes the Caitlyn CLI's command manifest, {@code commands.json},
 * which scripts/generate.sh copies to cli/internal/spec/. Settings: {@code service} (required) and {@code version},
 * the SDK and CLI version stamped into the manifest.
 */
public final class CaitlynCliPlugin implements SmithyBuildPlugin {

    @Override
    public String getName() {
        return "caitlyn-cli-codegen";
    }

    @Override
    public void execute(PluginContext context) {
        ObjectNode settings = context.getSettings();
        ShapeId serviceId = ShapeId.from(settings.expectStringMember("service").getValue());
        String version = settings.getStringMemberOrDefault("version", "0.0.0");
        ServiceShape service = context.getModel().expectShape(serviceId, ServiceShape.class);
        if (!service.hasTrait(CaitlynTraits.PROTOCOL)) {
            throw new CodegenException(serviceId + " must have the " + CaitlynTraits.PROTOCOL + " protocol trait");
        }
        ObjectNode manifest = new CommandManifest(context.getModel(), service, version).toNode();
        context.getFileManifest().writeFile("commands.json", Node.prettyPrintJson(manifest) + "\n");
    }
}
