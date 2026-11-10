package ai.caitlyn.codegen.go;

import ai.caitlyn.codegen.model.CaitlynTraits;

import software.amazon.smithy.build.PluginContext;
import software.amazon.smithy.build.SmithyBuildPlugin;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.directed.CodegenDirector;
import software.amazon.smithy.model.shapes.ServiceShape;

/**
 * smithy-build plugin {@code caitlyn-go-client-codegen}: generates the Caitlyn Go SDK on the hand-written
 * runtime github.com/caitlyn-ai/caitlyn-go/core. Output is gofmt-ready, not gofmt-ed: build.sh runs gofmt.
 */
public final class CaitlynGoPlugin implements SmithyBuildPlugin {

    @Override
    public String getName() {
        return "caitlyn-go-client-codegen";
    }

    @Override
    public void execute(PluginContext context) {
        GoSettings settings = GoSettings.from(context.getSettings());
        ServiceShape service = context.getModel().expectShape(settings.service(), ServiceShape.class);
        if (!service.hasTrait(CaitlynTraits.PROTOCOL)) {
            throw new CodegenException(settings.service() + " must have the " + CaitlynTraits.PROTOCOL + " protocol trait");
        }
        ModelFacts facts = new ModelFacts(context.getModel(), settings.service());
        CodegenDirector<GoWriter, GoContext.Integration, GoContext, GoSettings> director = new CodegenDirector<>();
        director.directedCodegen(new CaitlynGoCodegen(facts));
        director.integrationClass(GoContext.Integration.class);
        director.fileManifest(context.getFileManifest());
        director.model(context.getModel());
        director.settings(settings);
        director.service(settings.service());
        director.performDefaultCodegenTransforms();
        director.run();
    }
}
