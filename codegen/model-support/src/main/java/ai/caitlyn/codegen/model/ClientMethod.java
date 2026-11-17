package ai.caitlyn.codegen.model;

import java.util.List;
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
 * @param namespace          the bound resource's place in the resource tree, outermost first: each resource's
 *                           name minus a trailing "Resource", pluralised ({@code knowledgeBases.documents}); or
 *                           {@code @clientMethod}'s namespace, which may also be a dotted path
 *                           ({@code agents.versions}: {@code client.agents.versions.get})
 * @param method             {@code create}, {@code get}, {@code update}, {@code delete}, {@code list}, {@code put}
 *                           for lifecycle operations, else the operation's name less its resource's own name
 *                           ({@code StartIngestionBatch} on IngestionBatch gives {@code start}); or
 *                           {@code @clientMethod}'s name
 * @param positionalMember   the identifier a non-lifecycle instance operation of a single-identifier resource
 *                           takes positionally ({@code conversations.send(conversationId, …)})
 * @param resource           the resource the operation is bound to, if any
 */
public record ClientMethod(String namespace, String method, Optional<String> positionalMember, Optional<ResourceShape> resource) {

    /**
     * The namespace's segments, outermost first: {@code agents.versions} gives {@code [agents, versions]}, and a
     * plain namespace one segment. Each SDK nests a client object per segment, in its own casing (PROTOCOL.md 10).
     */
    public List<String> path() {
        return List.of(namespace.split("\\."));
    }

    /** The innermost segment, which names the client object that holds the methods ({@code versions}). */
    public String leaf() {
        List<String> p = path();
        return p.get(p.size() - 1);
    }

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
            if (!ns.get().matches("[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)*")) {
                throw new CodegenException(id + ": @clientMethod namespace " + ns.get() + " is not a dotted path of lower camel case words");
            }
            return new ClientMethod(ns.get(), mn.get(), positional, Optional.ofNullable(bound));
        }
        if (bound == null) {
            throw new CodegenException(id + " is bound to no resource and has no @clientMethod");
        }
        return new ClientMethod(namespaceOf(model, bound), lifecycle != null ? lifecycle : instanceMethod(id.getName(), bound), positional,
                Optional.of(bound));
    }

    /**
     * A bound operation's method: the operation's name less the resource's own name, lower camel case
     * ({@code StartIngestionBatch} gives {@code start}, {@code CompleteIngestionBatchUploads} {@code completeUploads},
     * {@code RetryDocument} {@code retry}), or the whole name when it does not contain the resource's name
     * ({@code EnableLayoutAwareSearch}).
     */
    static String instanceMethod(String operation, ResourceShape r) {
        String own = r.getId().getName().replaceFirst("Resource$", "");
        String rest = operation.replaceFirst(own, "");
        String name = rest.isEmpty() || rest.equals(operation) ? operation : rest;
        return Character.toLowerCase(name.charAt(0)) + name.substring(1);
    }

    /**
     * A resource's namespace: its parents' namespaces, outermost first, then its own
     * ({@code DocumentResource} under {@code KnowledgeBase} gives {@code knowledgeBases.documents}). PROTOCOL.md 10:
     * namespaces follow the resource tree. A child whose name starts with its parent's drops that part, as the
     * path already says it ({@code DocumentVersion} under {@code DocumentResource} gives {@code versions},
     * {@code IngestionBatchItem} under {@code IngestionBatch} gives {@code items}).
     */
    public static String namespaceOf(Model model, ResourceShape r) {
        return model.getResourceShapes().stream()
                .filter(p -> p.getResources().contains(r.getId()))
                .findFirst()
                .map(p -> namespaceOf(model, p) + "." + plural(ownName(r, p)))
                .orElse(namespaceOf(r));
    }

    /** {@code DocumentResource} gives {@code documents}, {@code Version} gives {@code versions}, {@code Policy} gives {@code policies}. */
    public static String namespaceOf(ResourceShape r) {
        return plural(r.getId().getName().replaceFirst("Resource$", ""));
    }

    private static String ownName(ResourceShape child, ResourceShape parent) {
        String n = child.getId().getName().replaceFirst("Resource$", "");
        String p = parent.getId().getName().replaceFirst("Resource$", "");
        return n.startsWith(p) && n.length() > p.length() && Character.isUpperCase(n.charAt(p.length())) ? n.substring(p.length()) : n;
    }

    /** English plurals, lower camel case: Batch gives batches, Policy policies, Entry entries, Key keys. */
    static String plural(String n) {
        String plural;
        if (n.matches(".*[^aeiou]y$")) plural = n.substring(0, n.length() - 1) + "ies";
        else if (n.matches(".*(s|x|z|ch|sh)$")) plural = n + "es";
        else plural = n + "s";
        return Character.toLowerCase(plural.charAt(0)) + plural.substring(1);
    }
}
