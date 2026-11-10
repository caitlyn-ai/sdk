package ai.caitlyn.codegen.python;

import software.amazon.smithy.codegen.core.SmithyIntegration;

/** Extension point for the Python generator (discovered with ServiceLoader; none are needed yet). */
public interface PythonIntegration extends SmithyIntegration<PythonSettings, PythonWriter, GenerationContext> {}
