package ai.caitlyn.codegen.go;

import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;

/**
 * Plugin settings from smithy-build.json:
 * <pre>
 * "caitlyn-go-client-codegen": {
 *   "service": "ai.caitlyn.v3#Caitlyn",
 *   "module": "github.com/caitlyn-ai/sdk/go",   // Go module path of the generated SDK
 *   "package": "caitlyn",                // package name
 *   "version": "0.0.1",
 *   "coreModule": "github.com/caitlyn-ai/sdk/go/core", "coreVersion": "v0.0.1",
 *   "coreReplace": "../caitlyn-core",    // optional: a replace directive, for development
 *   "handWritten": ["SendMessage"]       // optional: operations whose exported method is hand-written in the
 *                                        // package; the generated one is unexported (send) for it to call
 * }
 * </pre>
 */
record GoSettings(ShapeId service, String module, String packageName, String version,
                  String coreModule, String coreVersion, String coreReplace, java.util.Set<String> handWritten) {

    static GoSettings from(ObjectNode node) {
        return new GoSettings(
                ShapeId.from(node.expectStringMember("service").getValue()),
                node.getStringMemberOrDefault("module", "github.com/caitlyn-ai/sdk/go"),
                node.getStringMemberOrDefault("package", "caitlyn"),
                node.getStringMemberOrDefault("version", "0.0.1"),
                node.getStringMemberOrDefault("coreModule", "github.com/caitlyn-ai/sdk/go/core"),
                node.getStringMemberOrDefault("coreVersion", "v0.0.1"),
                node.getStringMemberOrDefault("coreReplace", ""),
                java.util.Set.copyOf(node.getArrayMember("handWritten").map(a -> a.getElementsAs(n -> n.expectStringNode().getValue()))
                        .orElse(java.util.List.of())));
    }
}
