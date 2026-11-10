package ai.caitlyn.codegen.python;

import java.util.List;
import software.amazon.smithy.build.FileManifest;
import software.amazon.smithy.codegen.core.CodegenContext;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.codegen.core.WriterDelegator;
import software.amazon.smithy.model.Model;

/** Everything a generator step needs, plus the shape facts computed once in {@link ModelFacts}. */
record GenerationContext(
        Model model,
        PythonSettings settings,
        SymbolProvider symbolProvider,
        FileManifest fileManifest,
        WriterDelegator<PythonWriter> writerDelegator,
        List<PythonIntegration> integrations,
        ModelFacts facts) implements CodegenContext<PythonSettings, PythonWriter, PythonIntegration> {}
