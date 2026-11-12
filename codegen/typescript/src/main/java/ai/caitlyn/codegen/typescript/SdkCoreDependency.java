package ai.caitlyn.codegen.typescript;

import java.util.List;
import software.amazon.smithy.codegen.core.SymbolDependency;
import software.amazon.smithy.typescript.codegen.Dependency;

/** The hand-written runtime package the generated client depends on. */
final class SdkCoreDependency implements Dependency {
    static final String PACKAGE = "@caitlyn-ai/sdk-core";
    /**
     * The runtime is released with the SDK, at the same version. In the repository's npm workspace
     * (typescript/package.json) this resolves to typescript/packages/sdk-core. A placeholder: scripts/postgen-ts.mjs
     * rewrites the generated package.json with the version in VERSION, as scripts/version.mjs stamps it.
     */
    static final String VERSION = "0.0.0";
    static final SdkCoreDependency INSTANCE = new SdkCoreDependency();

    @Override
    public String getPackageName() {
        return PACKAGE;
    }

    @Override
    public List<SymbolDependency> getDependencies() {
        return List.of(SymbolDependency.builder()
            .dependencyType("dependencies")
            .packageName(PACKAGE)
            .version(VERSION)
            .build());
    }
}
