package ai.caitlyn.codegen.rust;

import java.util.List;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.codegen.core.CodegenContext;
import software.amazon.smithy.codegen.core.SmithyIntegration;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.codegen.core.WriterDelegator;
import software.amazon.smithy.model.Model;

/** Everything a generator step needs, plus the facts computed once in {@link ModelFacts}. */
record RustContext(
        Model model,
        RustSettings settings,
        SymbolProvider symbolProvider,
        FileManifest fileManifest,
        WriterDelegator<RustWriter> writerDelegator,
        List<RustContext.Integration> integrations,
        ModelFacts facts,
        RustTypes types) implements CodegenContext<RustSettings, RustWriter, RustContext.Integration> {

    /** Extension point (discovered with ServiceLoader; none are needed yet). */
    public interface Integration extends SmithyIntegration<RustSettings, RustWriter, RustContext> {}
}
