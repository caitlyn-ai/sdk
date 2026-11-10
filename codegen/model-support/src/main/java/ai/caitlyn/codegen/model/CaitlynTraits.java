package ai.caitlyn.codegen.model;

import java.util.Optional;
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

    public static Optional<ObjectNode> object(Shape shape, ShapeId trait) {
        return node(shape, trait).flatMap(Node::asObjectNode);
    }

    public static Optional<String> stringMember(Shape shape, ShapeId trait, String member) {
        return object(shape, trait).flatMap(o -> o.getStringMember(member)).map(s -> s.getValue());
    }
}
