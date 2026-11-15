package ai.caitlyn.codegen.model;

import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.ShapeId;

/** Shared rules for {@code @smithy.waiters#waitable} waiters, so every generator reads a waiter the same way. */
public final class Waiters {
    private Waiters() {}

    /**
     * Whether the waiter succeeds only on an error, as GetDocument's {@code Deleted} succeeds on NotFoundError. Such a
     * waiter has no output to return, so every SDK's method for it returns nothing on success (PROTOCOL.md 10.1).
     * A waiter whose success acceptors match both outputs and errors would return an output only sometimes, and is
     * refused.
     */
    public static boolean succeedsOnError(ShapeId operation, String name, ObjectNode waiter) {
        boolean onOutput = false;
        boolean onError = false;
        for (Node a : waiter.expectArrayMember("acceptors").getElements()) {
            ObjectNode acceptor = a.expectObjectNode();
            if (!acceptor.expectStringMember("state").getValue().equals("success")) {
                continue;
            }
            ObjectNode matcher = acceptor.expectObjectMember("matcher");
            boolean error = matcher.getStringMember("errorType").isPresent()
                    || matcher.getBooleanMember("success").map(b -> !b.getValue()).orElse(false);
            if (error) {
                onError = true;
            } else {
                onOutput = true;
            }
        }
        if (onOutput && onError) {
            throw new CodegenException(operation + ": waiter " + name + " succeeds both on an output and on an error");
        }
        return onError;
    }
}
