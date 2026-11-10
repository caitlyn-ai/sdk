package ai.caitlyn.codegen.model;

import java.util.Optional;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ResourceShape;
import software.amazon.smithy.model.shapes.ShapeId;

/**
 * Where an operation appears on the method-style clients (PROTOCOL.md section 10), in the model's own
 * lower-camel spelling. Each generator turns the names into its language's case.
 *
 * @param namespace          {@code documents}, {@code versions}: the bound resource's name minus a trailing
 *                           "Resource", pluralised; or {@code @clientMethod}'s namespace
 * @param method             {@code create}, {@code get}, {@code update}, {@code delete}, {@code list}, {@code put}
 *                           for lifecycle operations, else the operation's name; or {@code @clientMethod}'s name
 * @param positionalMember   the identifier a non-lifecycle instance operation of a single-identifier resource
 *                           takes positionally ({@code conversations.send(conversationId, …)})
 * @param resource           the resource the operation is bound to, if any
 */
public record ClientMethod(String namespace, String method, Optional<String> positionalMember, Optional<ResourceShape> resource) {

    public static ClientMethod of(Model model, OperationShape op) {
        ShapeId id = op.getId();
        ResourceShape bound = null;
        String lifecycle = null;
        boolean instance = false;
        for (ResourceShape r : model.getResourceShapes()) {
            if (r.getCreate().filter(id::equals).isPresent()) { bound = r; lifecycle = "create"; }
            else if (r.getRead().filter(id::equals).isPresent()) { bound = r; lifecycle = "get"; }
            else if (r.getUpdate().filter(id::equals).isPresent()) { bound = r; lifecycle = "update"; }
            else if (r.getDelete().filter(id::equals).isPresent()) { bound = r; lifecycle = "delete"; }
            else if (r.getList().filter(id::equals).isPresent()) { bound = r; lifecycle = "list"; }
            else if (r.getPut().filter(id::equals).isPresent()) { bound = r; lifecycle = "put"; }
            else if (r.getOperations().contains(id)) { bound = r; instance = true; }
            else if (r.getCollectionOperations().contains(id)) { bound = r; }
        }
        Optional<String> positional = instance && bound.getIdentifiers().size() == 1
                ? Optional.of(bound.getIdentifiers().keySet().iterator().next()) : Optional.empty();
        Optional<String> ns = CaitlynTraits.stringMember(op, CaitlynTraits.CLIENT_METHOD, "namespace");
        Optional<String> mn = CaitlynTraits.stringMember(op, CaitlynTraits.CLIENT_METHOD, "name");
        String lowerOp = Character.toLowerCase(id.getName().charAt(0)) + id.getName().substring(1);
        if (ns.isPresent() && mn.isPresent()) {
            return new ClientMethod(ns.get(), mn.get(), positional, Optional.ofNullable(bound));
        }
        if (bound == null) {
            throw new CodegenException(id + " is bound to no resource and has no @clientMethod");
        }
        return new ClientMethod(namespaceOf(bound), lifecycle != null ? lifecycle : lowerOp, positional, Optional.of(bound));
    }

    /** {@code DocumentResource} gives {@code documents}, {@code Version} gives {@code versions}, {@code Policy} gives {@code policies}. */
    public static String namespaceOf(ResourceShape r) {
        String n = r.getId().getName().replaceFirst("Resource$", "");
        String plural = n.endsWith("y") ? n.substring(0, n.length() - 1) + "ies" : n.endsWith("s") ? n + "es" : n + "s";
        return Character.toLowerCase(plural.charAt(0)) + plural.substring(1);
    }
}
