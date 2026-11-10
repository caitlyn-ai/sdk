package ai.caitlyn.codegen.go;

import java.util.List;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.codegen.core.CodegenContext;
import software.amazon.smithy.codegen.core.SmithyIntegration;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.codegen.core.WriterDelegator;
import software.amazon.smithy.model.Model;

/** Everything a generator step needs, plus the facts computed once in {@link ModelFacts}. */
record GoContext(
        Model model,
        GoSettings settings,
        SymbolProvider symbolProvider,
        FileManifest fileManifest,
        WriterDelegator<GoWriter> writerDelegator,
        List<GoContext.Integration> integrations,
        ModelFacts facts,
        GoTypes types) implements CodegenContext<GoSettings, GoWriter, GoContext.Integration> {

    /** Extension point (discovered with ServiceLoader; none are needed yet). */
    public interface Integration extends SmithyIntegration<GoSettings, GoWriter, GoContext> {}
}
