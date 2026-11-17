package ai.caitlyn.codegen.rust;

import ai.caitlyn.codegen.model.CaitlynTraits;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.DocumentationTrait;

/**
 * The {@code @uploadTarget} members of a service (PROTOCOL.md 10). A target is a member of the operation's input, or a
 * dotted path to a member of a nested structure ({@code avatar.mark.pictureUploadId}). The structure that holds the
 * member gets a file field beside it, named after the member less its {@code UploadId} ({@code picture}), or
 * {@code file} for a member named {@code uploadId}. The operation's method uploads a file set there with
 * {@code core().uploads()}, reserved with the purpose the member's documentation names
 * ({@code purpose: {agentAvatar: true}}), and sends the upload's id in its place.
 */
final class UploadTargets {
    private static final Pattern PURPOSE = Pattern.compile("`purpose: \\{(\\w+): true\\}`");

    /**
     * One target.
     *
     * @param operation the operation
     * @param path      the members from the input to the identifier, outermost first
     * @param holder    the structure that holds the identifier (the input for a top-level target)
     * @param fileField the Rust name of the file field beside the identifier
     * @param purpose   the member of the upload's {@code purpose} to set true, if the member's documentation names one
     */
    record Target(ShapeId operation, List<MemberShape> path, ShapeId holder, String fileField, Optional<String> purpose) {
        MemberShape leaf() {
            return path.get(path.size() - 1);
        }

        String dotted() {
            return String.join(".", path.stream().map(MemberShape::getMemberName).toList());
        }
    }

    final Map<ShapeId, Target> byOperation = new LinkedHashMap<>();
    /** Holder structure -> identifier member name -> file field. */
    final Map<ShapeId, Map<String, String>> fileFields = new HashMap<>();

    UploadTargets(Model model, ServiceShape service) {
        OperationIndex ops = OperationIndex.of(model);
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            Optional<String> member = CaitlynTraits.stringMember(op, CaitlynTraits.UPLOAD_TARGET, "member");
            if (member.isEmpty()) {
                continue;
            }
            Shape current = ops.expectInputShape(op);
            List<MemberShape> path = new ArrayList<>();
            ShapeId holder = null;
            for (String seg : member.get().split("\\.")) {
                if (!(current instanceof StructureShape s)) {
                    throw new CodegenException(op.getId() + ": @uploadTarget " + member.get() + " walks into a non-structure");
                }
                MemberShape m = s.getMember(seg).orElseThrow(() ->
                        new CodegenException(op.getId() + ": @uploadTarget " + member.get() + ": " + s.getId() + " has no member " + seg));
                holder = s.getId();
                path.add(m);
                current = model.expectShape(m.getTarget());
            }
            if (!current.isStringShape()) {
                throw new CodegenException(op.getId() + ": @uploadTarget " + member.get() + " must name an identifier (a string)");
            }
            MemberShape leaf = path.get(path.size() - 1);
            String field = fileName(leaf.getMemberName());
            StructureShape h = model.expectShape(holder, StructureShape.class);
            if (h.getAllMembers().keySet().stream().anyMatch(n -> Names.snake(n).equals(field))) {
                throw new CodegenException(op.getId() + ": the file field " + field + " clashes with a member of " + holder);
            }
            Optional<String> purpose = Optional.empty();
            String doc = leaf.getMemberTrait(model, DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
            Matcher pm = PURPOSE.matcher(doc);
            if (pm.find()) {
                purpose = Optional.of(pm.group(1));
            }
            String existing = fileFields.computeIfAbsent(holder, k -> new HashMap<>()).put(leaf.getMemberName(), field);
            if (existing != null && !existing.equals(field)) {
                throw new CodegenException(holder + "$" + leaf.getMemberName() + " has two file fields");
            }
            byOperation.put(op.getId(), new Target(op.getId(), List.copyOf(path), holder, field, purpose));
        }
    }

    /** {@code uploadId} gives {@code file}, {@code pictureUploadId} {@code picture}, and any other name {@code <name>_file}. */
    static String fileName(String member) {
        if (member.equals("uploadId")) {
            return "file";
        }
        if (member.endsWith("UploadId")) {
            return Names.snake(member.substring(0, member.length() - "UploadId".length()));
        }
        return Names.snake(member) + "_file";
    }

    Optional<String> fileField(ShapeId holder, String member) {
        return Optional.ofNullable(fileFields.getOrDefault(holder, Map.of()).get(member));
    }
}
