package ai.caitlyn.codegen.python;

import ai.caitlyn.codegen.model.CaitlynTraits;

import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.build.SmithyBuildPlugin;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.directed.CodegenDirector;
import software.amazon.smithy.model.shapes.ServiceShape;

/**
 * smithy-build plugin {@code caitlyn-python-client-codegen}: generates the Caitlyn Python SDK
 * (Pydantic v2 models, sync and async clients) on the hand-written caitlyn-core runtime.
 */
public final class CaitlynPythonPlugin implements SmithyBuildPlugin {

    @Override
    public String getName() {
        return "caitlyn-python-client-codegen";
    }

    @Override
    public void execute(PluginContext context) {
        PythonSettings settings = PythonSettings.from(context.getSettings());
        ServiceShape service = context.getModel().expectShape(settings.service(), ServiceShape.class);
        if (!service.hasTrait(CaitlynTraits.PROTOCOL)) {
            throw new CodegenException(settings.service() + " must have the " + CaitlynTraits.PROTOCOL + " protocol trait");
        }
        // Computed from the model as written: result naming reads mixins, which codegen transforms flatten.
        ModelFacts facts = new ModelFacts(context.getModel(), settings.service());

        CodegenDirector<PythonWriter, PythonIntegration, GenerationContext, PythonSettings> director = new CodegenDirector<>();
        director.directedCodegen(new CaitlynPythonCodegen(facts));
        director.integrationClass(PythonIntegration.class);
        director.fileManifest(context.getFileManifest());
        director.model(context.getModel());
        director.settings(settings);
        director.service(settings.service());
        director.performDefaultCodegenTransforms();
        director.run();
    }
}
