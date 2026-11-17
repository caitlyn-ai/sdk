package ai.caitlyn.codegen.go;

import ai.caitlyn.codegen.model.ScopeTree;
import ai.caitlyn.codegen.model.ScopeTree.Kind;
import ai.caitlyn.codegen.model.ScopeTree.Node;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import software.amazon.smithy.codegen.core.CodegenException;

/**
 * The Go spelling of the scope tree (PROTOCOL.md 10, spec 2.3): a type for each node, and how each node is reached
 * from its parent. Names and places come from {@link ScopeTree}; this class only spells them.
 *
 * <ul>
 *   <li>A collection is a field of its parent ({@code c.KnowledgeBases}), and its scope a method on the parent named
 *       in the singular ({@code c.KnowledgeBase(id)}), returning a {@code …Scope}.</li>
 *   <li>A named scope is a method with no arguments ({@code agent.Draft()}, {@code agent.Live()}).</li>
 *   <li>A plain namespace and a singleton scope are fields ({@code kb.Ingestion}, {@code kb.Access}).</li>
 * </ul>
 *
 * A collection or scope type is named after the thing ({@code Documents}, {@code DocumentScope}), prefixed with its
 * owner's name only where two would otherwise share a name ({@code AgentVersions}, {@code DocumentVersions}).
 * Namespaces and singletons are always prefixed with their owner ({@code KnowledgeBaseIngestion},
 * {@code CoreIngestion}, {@code DocumentAccess}).
 */
final class GoScopes {
    final ScopeTree tree;
    private final Map<Node, String> names = new IdentityHashMap<>();
    private final List<Node> nodes = new ArrayList<>();

    GoScopes(ScopeTree tree, Set<String> shapeNames) {
        this.tree = tree;
        for (Node n : tree.root.walk()) {
            // A collection with no calls of its own (the top-level conversations) gets no type: its scope is still
            // made by its parent's singular method.
            if (!empty(n) && !(n.kind == Kind.COLLECTION && n.methods.isEmpty())) {
                nodes.add(n);
            }
        }
        Map<Node, String> candidate = new IdentityHashMap<>();
        for (Node n : nodes) {
            candidate.put(n, candidate(n));
        }
        // Namespaces and singletons always carry their owner's name, so they never collide with a collection or scope of
        // the same short name (core.documents is CoreDocuments; kb.documents stays Documents).
        Map<String, List<Node>> byName = new LinkedHashMap<>();
        for (Node n : nodes) {
            String key = n.kind == Kind.NAMESPACE || singleton(n) ? "\u0000" + n.path() : candidate.get(n);
            byName.computeIfAbsent(key, k -> new ArrayList<>()).add(n);
        }
        Map<Node, Boolean> prefixed = new IdentityHashMap<>();
        for (List<Node> group : byName.values()) {
            for (Node n : group) {
                boolean alwaysPrefixed = n.kind == Kind.NAMESPACE || singleton(n);
                prefixed.put(n, alwaysPrefixed || (group.size() > 1 && owner(n) != null));
            }
        }
        for (Node n : nodes) {
            names.put(n, resolve(n, candidate, prefixed));
        }
        Map<String, Node> seen = new LinkedHashMap<>();
        for (Node n : nodes) {
            String name = names.get(n);
            if (n.kind != Kind.ROOT && shapeNames.contains(name)) {
                // A model shape has the name (the ConversationScope enum): a scope becomes …Ref, anything else …Collection.
                name = made(n) ? name.substring(0, name.length() - "Scope".length()) + "Ref" : name + "Collection";
                names.put(n, name);
            }
            Node prev = seen.put(name, n);
            if (prev != null) {
                throw new CodegenException("Go type " + name + " would name both " + prev.path() + " and " + n.path());
            }
        }
    }

    /** Every node with something on it, depth first. */
    List<Node> nodes() {
        return nodes;
    }

    String type(Node n) {
        String t = names.get(n);
        if (t == null) {
            throw new CodegenException(n.path() + " has no Go type: it holds nothing");
        }
        return t;
    }

    /** A node that holds nothing (the messages(id) scope, the top-level conversations collection's own calls) gets no type. */
    static boolean empty(Node n) {
        if (n.kind == Kind.ROOT) {
            return false;
        }
        if (!n.methods.isEmpty() || n.watch.isPresent()) {
            return false;
        }
        for (Node c : n.children.values()) {
            if (!empty(c)) {
                return false;
            }
        }
        return n.scope == null || empty(n.scope);
    }

    /** A collection field is written only when the collection has calls of its own. */
    static boolean collectionField(Node n) {
        return n.kind == Kind.COLLECTION && !n.methods.isEmpty();
    }

    /** A scope made by calling a collection, or a named scope: a value the caller holds (…Scope). */
    static boolean made(Node n) {
        return n.kind == Kind.SCOPE && (n.alias.isPresent() || (n.parent != null && n.parent.kind == Kind.COLLECTION));
    }

    /** A singleton scope reached as a property (kb.access, caitlyn.events). */
    static boolean singleton(Node n) {
        return n.kind == Kind.SCOPE && !made(n);
    }

    private static String base(Node n) {
        return switch (n.kind) {
            case ROOT -> "Client";
            case COLLECTION, NAMESPACE -> Names.exported(n.name);
            case SCOPE -> n.alias.isPresent() ? Names.exported(n.alias.get())
                    : n.parent.kind == Kind.COLLECTION ? Names.exported(n.parent.singular) : Names.exported(n.name);
        };
    }

    private static String candidate(Node n) {
        return base(n) + (made(n) ? "Scope" : "");
    }

    /**
     * The node whose name prefixes this one's: the nearest scope or collection above it, or the core namespace. A
     * collection owner gives its singular ({@code agents.options} is AgentOptions). Null at the top of the client.
     */
    private static Node owner(Node n) {
        // A scope made by its collection is owned by what owns the collection.
        Node start = made(n) && n.alias.isEmpty() ? n.parent.parent : n.parent;
        for (Node p = start; p != null; p = p.parent) {
            if (p.kind == Kind.ROOT) {
                return null;
            }
            if (p.kind == Kind.SCOPE || p.kind == Kind.COLLECTION) {
                return p;
            }
            if (p.kind == Kind.NAMESPACE && p.name.equals("core") && p.parent.kind == Kind.ROOT) {
                return p;
            }
        }
        return null;
    }

    private String resolve(Node n, Map<Node, String> candidate, Map<Node, Boolean> prefixed) {
        String own = candidate.get(n);
        if (!prefixed.get(n)) {
            return own;
        }
        Node o = owner(n);
        if (o == null) {
            return own;
        }
        String ownerName;
        if (o.kind == Kind.COLLECTION) {
            ownerName = Names.exported(o.singular);
        } else {
            String r = names.containsKey(o) ? names.get(o) : candidate.containsKey(o) ? resolve(o, candidate, prefixed) : base(o);
            ownerName = r.endsWith("Scope") ? r.substring(0, r.length() - "Scope".length()) : r;
        }
        return own.startsWith(ownerName) ? own : ownerName + own;
    }

    /** The identifiers a node's value holds, outermost first: a scope's own; any other node its parent's. */
    static List<ScopeTree.Identifier> held(Node n) {
        if (n.kind == Kind.ROOT) {
            return List.of();
        }
        if (n.kind == Kind.SCOPE) {
            return n.identifiers;
        }
        return held(n.parent);
    }

    /** The Go field (and parameter) holding an identifier: knowledgeBaseId gives knowledgeBaseID. */
    static String idVar(String identifier) {
        return Names.unexported(identifier);
    }

    /** The nearest scope at or above a node (the root when there is none). */
    static Node scopeOf(Node n) {
        Node p = n;
        while (p.kind != Kind.SCOPE && p.kind != Kind.ROOT) {
            p = p.parent;
        }
        return p;
    }
}
