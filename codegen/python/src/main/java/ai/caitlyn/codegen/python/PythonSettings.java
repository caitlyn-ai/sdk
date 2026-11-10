package ai.caitlyn.codegen.python;

import java.util.HashMap;
import java.util.Map;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.node.StringNode;
import software.amazon.smithy.model.shapes.ShapeId;

/**
 * Plugin settings from smithy-build.json:
 * <pre>
 * "caitlyn-python-client-codegen": {
 *   "service": "ai.caitlyn.v3#Caitlyn",
 *   "package": "caitlyn",            // import name
 *   "distribution": "caitlyn-sdk",   // PyPI name
 *   "version": "0.0.1",
 *   "methods": {"ListDocuments": "documents.list"},   // only where the model has no @clientMethod
 *   "sseFinal": {"SendMessage": "messageCompleted"},  // only where @sseEvents has no final
 *   "uploads": {"CreateUpload": "", "CreateDocument": "uploadId"}  // only without the upload traits
 * }
 * </pre>
 */
record PythonSettings(
        ShapeId service,
        String packageName,
        String distribution,
        String version,
        Map<String, String> methods,
        Map<String, String> sseFinal,
        Map<String, String> uploads) {

    static PythonSettings from(ObjectNode node) {
        return new PythonSettings(
                ShapeId.from(node.expectStringMember("service").getValue()),
                node.getStringMemberOrDefault("package", "caitlyn"),
                node.getStringMemberOrDefault("distribution", "caitlyn-sdk"),
                node.getStringMemberOrDefault("version", "0.0.1"),
                stringMap(node, "methods"),
                stringMap(node, "sseFinal"),
                stringMap(node, "uploads"));
    }

    private static Map<String, String> stringMap(ObjectNode node, String key) {
        Map<String, String> out = new HashMap<>();
        node.getObjectMember(key).ifPresent(o -> o.getMembers().forEach(
                (k, v) -> out.put(k.getValue(), v.asStringNode().map(StringNode::getValue).orElse(""))));
        return out;
    }

    String module(String name) {
        return packageName + "." + name;
    }

    String file(String name) {
        return packageName + "/" + name + ".py";
    }
}
