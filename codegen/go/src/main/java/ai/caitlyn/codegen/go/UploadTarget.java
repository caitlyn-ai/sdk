package ai.caitlyn.codegen.go;

import ai.caitlyn.codegen.model.CaitlynTraits;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.DocumentationTrait;

/**
 * An operation's {@code @uploadTarget(member)} resolved against the model (PROTOCOL.md 10, Uploads). {@code member}
 * is a member of the input or a dotted path to a nested one ({@code avatar.mark.pictureUploadId}). In Go the
 * structure that holds the identifier gains a file field beside it ({@code File} for {@code uploadId},
 * {@code PictureFile} for {@code pictureUploadId}): set the file and the method uploads it and sends its id.
 *
 * @param path     the members from the input to the identifier, outermost first
 * @param owners   the structure each member of {@code path} belongs to: owners.get(0) is the input
 * @param purpose  the {@code UploadPurpose} member the identifier's documentation names (`purpose: {agentAvatar: true}`),
 *                 if any: the upload is reserved with it set to true
 */
record UploadTarget(List<MemberShape> path, List<StructureShape> owners, Optional<String> purpose) {

    private static final Pattern PURPOSE = Pattern.compile("purpose: \\{(\\w+): true\\}");

    /** The identifier member at the end of the path. */
    MemberShape member() {
        return path.get(path.size() - 1);
    }

    /** The structure that holds the identifier, and so the file field. */
    StructureShape owner() {
        return owners.get(owners.size() - 1);
    }

    boolean nested() {
        return path.size() > 1;
    }

    /** The Go file field beside the identifier: uploadId gives File, pictureUploadId PictureFile. */
    String fileField() {
        return fileField(member().getMemberName());
    }

    static String fileField(String member) {
        String stem = member.replaceFirst("UploadId$", "").replaceFirst("(?i)^uploadId$", "");
        return stem.isEmpty() ? "File" : Names.exported(stem) + "File";
    }

    static Optional<UploadTarget> of(Model model, OperationShape op, StructureShape uploadPurpose) {
        Optional<String> dotted = CaitlynTraits.stringMember(op, CaitlynTraits.UPLOAD_TARGET, "member");
        if (dotted.isEmpty()) {
            return Optional.empty();
        }
        List<MemberShape> path = new ArrayList<>();
        List<StructureShape> owners = new ArrayList<>();
        Shape current = OperationIndex.of(model).expectInputShape(op);
        for (String seg : dotted.get().split("\\.")) {
            if (!(current instanceof StructureShape s)) {
                throw new CodegenException(op.getId() + ": @uploadTarget " + dotted.get() + " walks into " + current.getId() + ", which is not a structure");
            }
            MemberShape m = s.getMember(seg).orElseThrow(() -> new CodegenException(
                    op.getId() + ": @uploadTarget " + dotted.get() + ": " + s.getId() + " has no member " + seg));
            owners.add(s);
            path.add(m);
            current = model.expectShape(m.getTarget());
        }
        MemberShape id = path.get(path.size() - 1);
        if (!current.isStringShape()) {
            throw new CodegenException(op.getId() + ": @uploadTarget " + dotted.get() + " is not a string identifier");
        }
        String field = fileField(id.getMemberName());
        StructureShape owner = owners.get(owners.size() - 1);
        for (MemberShape other : owner.getAllMembers().values()) {
            if (Names.exported(other.getMemberName()).equals(field)) {
                throw new CodegenException(op.getId() + ": @uploadTarget's file field " + field + " clashes with " + other.getId());
            }
        }
        for (int i = 0; i < path.size() - 1; i++) {
            if (path.get(i).isRequired()) {
                // A required parent would be a value, not a pointer, in Go; the method copies the path as pointers.
                throw new CodegenException(op.getId() + ": @uploadTarget through the required member " + path.get(i).getId() + " is not supported yet");
            }
        }
        String doc = id.getMemberTrait(model, DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
        Matcher match = PURPOSE.matcher(doc.replaceAll("\\s+", " "));
        Optional<String> purpose = Optional.empty();
        if (match.find()) {
            String name = match.group(1);
            MemberShape pm = uploadPurpose.getMember(name).orElseThrow(() -> new CodegenException(
                    id.getId() + ": its documentation names the upload purpose " + name + ", which UploadPurpose does not have"));
            if (!model.expectShape(pm.getTarget()).isBooleanShape()) {
                throw new CodegenException(pm.getId() + ": an upload purpose named by a member's documentation must be a boolean");
            }
            purpose = Optional.of(name);
        }
        return Optional.of(new UploadTarget(List.copyOf(path), List.copyOf(owners), purpose));
    }
}
