package ai.caitlyn.codegen.rust;

import ai.caitlyn.codegen.model.CaitlynTraits;
import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.build.SmithyBuildPlugin;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.directed.CodegenDirector;
import software.amazon.smithy.model.shapes.ServiceShape;

/**
 * smithy-build plugin {@code caitlyn-rust-client-codegen}: generates the Caitlyn Rust SDK crate (caitlyn-sdk) on
 * the hand-written runtime crate caitlyn-sdk-core. Output is rustfmt-ready, not rustfmt-ed: generate.sh runs it.
 */
public final class CaitlynRustPlugin implements SmithyBuildPlugin {

    @Override
    public String getName() {
        return "caitlyn-rust-client-codegen";
    }

    @Override
    public void execute(PluginContext context) {
        RustSettings settings = RustSettings.from(context.getSettings());
        ServiceShape service = context.getModel().expectShape(settings.service(), ServiceShape.class);
        if (!service.hasTrait(CaitlynTraits.PROTOCOL)) {
            throw new CodegenException(settings.service() + " must have the " + CaitlynTraits.PROTOCOL + " protocol trait");
        }
        ModelFacts facts = new ModelFacts(context.getModel(), settings.service());
        CodegenDirector<RustWriter, RustContext.Integration, RustContext, RustSettings> director = new CodegenDirector<>();
        director.directedCodegen(new CaitlynRustCodegen(facts));
        director.integrationClass(RustContext.Integration.class);
        director.fileManifest(context.getFileManifest());
        director.model(context.getModel());
        director.settings(settings);
        director.service(settings.service());
        director.performDefaultCodegenTransforms();
        director.run();
    }
}
