package ai.caitlyn.codegen.model;

import java.util.Optional;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.node.ObjectNode;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.traits.Trait;

/**
 * Caitlyn's custom traits (the app repository's smithy/model/traits.smithy), read as dynamic traits:
 * their definitions travel in the model, so the generators need no Java trait classes.
 */
public final class CaitlynTraits {
    public static final ShapeId PROTOCOL = ShapeId.from("ai.caitlyn.protocols#restJson");
    public static final ShapeId SINCE = ShapeId.from("ai.caitlyn.traits#since");
    public static final ShapeId STABILITY = ShapeId.from("ai.caitlyn.traits#stability");
    public static final ShapeId SSE_EVENTS = ShapeId.from("ai.caitlyn.traits#sseEvents");
    public static final ShapeId CLIENT_METHOD = ShapeId.from("ai.caitlyn.traits#clientMethod");
    public static final ShapeId PRESIGNED_UPLOAD = ShapeId.from("ai.caitlyn.traits#presignedUpload");
    public static final ShapeId UPLOAD_TARGET = ShapeId.from("ai.caitlyn.traits#uploadTarget");
    public static final ShapeId CLEARABLE = ShapeId.from("ai.caitlyn.traits#clearable");
    public static final ShapeId ERROR_CODES = ShapeId.from("ai.caitlyn.traits#errorCodes");
    /** {@code @waitLimits}: the default time limit of each of an operation's waiters, in seconds, by waiter name. */
    public static final ShapeId WAIT_LIMITS = ShapeId.from("ai.caitlyn.traits#waitLimits");
    /** The limit of a waiter without a {@code @waitLimits} entry (PROTOCOL.md 10.1): five minutes. */
    public static final int DEFAULT_WAIT_LIMIT_SECONDS = 300;

    private CaitlynTraits() {}

    public static Optional<Node> node(Shape shape, ShapeId trait) {
        return shape.findTrait(trait).map(Trait::toNode);
    }

    /** The release that introduced the shape. Generators read a prepared model, so "next" never reaches them. */
    public static Optional<String> since(Shape shape) {
        return node(shape, SINCE).flatMap(Node::asStringNode).map(s -> s.getValue());
    }

    /** {@code ga}, {@code beta} or {@code internal}; an operation without the trait is {@code ga}. */
    public static String stability(Shape shape) {
        return node(shape, STABILITY).flatMap(Node::asStringNode).map(s -> s.getValue()).orElse("ga");
    }

    private static final ShapeId NO_CLIENT_METHOD = ShapeId.from("ai.caitlyn.traits#noClientMethod");

    /**
     * Whether the SDKs leave the operation out: {@code @stability("internal")} (for Caitlyn itself), or
     * {@code @noClientMethod(reason)}, a public operation that is called by systems holding no Caitlyn credential (a webhook
     * delivery) and documented in the API reference instead of being given a client method.
     */
    public static boolean omittedFromSdk(Shape shape) {
        return stability(shape).equals("internal") || shape.hasTrait(NO_CLIENT_METHOD);
    }

    public static Optional<ObjectNode> object(Shape shape, ShapeId trait) {
        return node(shape, trait).flatMap(Node::asObjectNode);
    }

    public static Optional<String> stringMember(Shape shape, ShapeId trait, String member) {
        return object(shape, trait).flatMap(o -> o.getStringMember(member)).map(s -> s.getValue());
    }

    private static final ShapeId WAITABLE = ShapeId.from("smithy.waiters#waitable");

    /**
     * A waiter's default time limit in seconds: its {@code @waitLimits} entry, else five minutes. Fails when the
     * operation's {@code @waitLimits} names a waiter its {@code @waitable} does not have, so a misspelt or removed
     * waiter cannot quietly fall back to five minutes.
     */
    public static int waitLimitSeconds(Shape operation, String waiter) {
        Optional<ObjectNode> waiters = object(operation, WAITABLE);
        for (String limited : object(operation, WAIT_LIMITS).map(o -> o.getStringMap().keySet()).orElse(java.util.Set.of())) {
            if (waiters.flatMap(w -> w.getMember(limited)).isEmpty()) {
                throw new CodegenException(operation.getId() + ": @waitLimits names " + limited + ", which is not one of its waiters");
            }
        }
        return object(operation, WAIT_LIMITS).flatMap(o -> o.getNumberMember(waiter)).map(n -> n.getValue().intValue())
                .orElse(DEFAULT_WAIT_LIMIT_SECONDS);
    }
}
