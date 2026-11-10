package ai.caitlyn.codegen.go;

import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;

/**
 * Plugin settings from smithy-build.json:
 * <pre>
 * "caitlyn-go-client-codegen": {
 *   "service": "ai.caitlyn.v3#Caitlyn",
 *   "module": "github.com/caitlyn-ai/caitlyn-go",   // Go module path of the generated SDK
 *   "package": "caitlyn",                // package name
 *   "version": "0.0.1",
 *   "coreModule": "github.com/caitlyn-ai/caitlyn-go/core", "coreVersion": "v0.0.1",
 *   "coreReplace": "../caitlyn-core"     // optional: a replace directive, for development
 * }
 * </pre>
 */
record GoSettings(ShapeId service, String module, String packageName, String version,
                  String coreModule, String coreVersion, String coreReplace) {

    static GoSettings from(ObjectNode node) {
        return new GoSettings(
                ShapeId.from(node.expectStringMember("service").getValue()),
                node.getStringMemberOrDefault("module", "github.com/caitlyn-ai/caitlyn-go"),
                node.getStringMemberOrDefault("package", "caitlyn"),
                node.getStringMemberOrDefault("version", "0.0.1"),
                node.getStringMemberOrDefault("coreModule", "github.com/caitlyn-ai/caitlyn-go/core"),
                node.getStringMemberOrDefault("coreVersion", "v0.0.1"),
                node.getStringMemberOrDefault("coreReplace", ""));
    }
}
