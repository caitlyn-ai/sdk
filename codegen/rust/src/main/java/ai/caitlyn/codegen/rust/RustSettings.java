package ai.caitlyn.codegen.rust;

import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;

/**
 * Plugin settings from smithy-build.json:
 * <pre>
 * "caitlyn-rust-client-codegen": {
 *   "service": "ai.caitlyn.v3#Caitlyn",
 *   "crate": "caitlyn-sdk",                 // the generated crate's name
 *   "version": "0.0.1",
 *   "coreCrate": "caitlyn-sdk-core", "coreVersion": "0.0.1",
 *   "corePath": "../caitlyn-sdk-core",      // optional: a path dependency, for the workspace
 *   "repository": "https://github.com/caitlyn-ai/sdk"
 * }
 * </pre>
 */
record RustSettings(ShapeId service, String crateName, String version, String coreCrate, String coreVersion,
                    String corePath, String repository) {

    static RustSettings from(ObjectNode node) {
        return new RustSettings(
                ShapeId.from(node.expectStringMember("service").getValue()),
                node.getStringMemberOrDefault("crate", "caitlyn-sdk"),
                node.getStringMemberOrDefault("version", "0.0.1"),
                node.getStringMemberOrDefault("coreCrate", "caitlyn-sdk-core"),
                node.getStringMemberOrDefault("coreVersion", "0.0.1"),
                node.getStringMemberOrDefault("corePath", ""),
                node.getStringMemberOrDefault("repository", "https://github.com/caitlyn-ai/sdk"));
    }

    /** The core crate's name as a Rust path: caitlyn_sdk_core. */
    String coreModule() {
        return coreCrate.replace('-', '_');
    }
}
