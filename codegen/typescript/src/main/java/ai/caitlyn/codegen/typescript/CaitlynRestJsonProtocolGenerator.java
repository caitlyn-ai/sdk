package ai.caitlyn.codegen.typescript;

import java.util.List;
import java.util.Set;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.traits.TimestampFormatTrait.Format;
import software.amazon.smithy.typescript.codegen.integration.HttpBindingProtocolGenerator;
import software.amazon.smithy.model.knowledge.HttpBinding;

/**
 * Protocol generator for {@code ai.caitlyn.protocols#restJson}.
 *
 * <p>The client is generated in schema mode: serialisation and error handling happen at run time in
 * {@code CaitlynRestJsonProtocol} (from {@code @caitlyn-ai/sdk-core}), driven by the generated schemas.
 * smithy-typescript therefore never calls the code-generating serde hooks below; they exist only to
 * satisfy {@link HttpBindingProtocolGenerator} and fail loudly if that ever changes.
 */
final class CaitlynRestJsonProtocolGenerator extends HttpBindingProtocolGenerator {

    CaitlynRestJsonProtocolGenerator() {
        super(true);
    }

    @Override
    public ShapeId getProtocol() {
        return CaitlynTypeScriptIntegration.PROTOCOL;
    }

    @Override
    public String getName() {
        return "caitlynRestJson";
    }

    @Override
    public void generateProtocolTests(GenerationContext context) {
        // No protocol compliance suite yet; the SDK repository's conformance suite covers behaviour.
    }

    @Override
    protected Format getDocumentTimestampFormat() {
        return Format.DATE_TIME;
    }

    @Override
    protected String getDocumentContentType() {
        return "application/json";
    }

    private static UnsupportedOperationException schemaOnly() {
        return new UnsupportedOperationException("caitlynRestJson supports schema-based generation only");
    }

    @Override
    protected void generateDocumentBodyShapeSerializers(GenerationContext c, Set<Shape> s) {
        throw schemaOnly();
    }

    @Override
    protected void generateDocumentBodyShapeDeserializers(GenerationContext c, Set<Shape> s) {
        throw schemaOnly();
    }

    @Override
    protected void serializeInputDocumentBody(GenerationContext c, OperationShape o, List<HttpBinding> b) {
        throw schemaOnly();
    }

    @Override
    protected void serializeInputEventDocumentPayload(GenerationContext c) {
        throw schemaOnly();
    }

    @Override
    protected void serializeOutputDocumentBody(GenerationContext c, OperationShape o, List<HttpBinding> b) {
        throw schemaOnly();
    }

    @Override
    protected void serializeErrorDocumentBody(GenerationContext c, StructureShape e, List<HttpBinding> b) {
        throw schemaOnly();
    }

    @Override
    protected void writeErrorCodeParser(GenerationContext c) {
        throw schemaOnly();
    }

    @Override
    protected void deserializeInputDocumentBody(GenerationContext c, OperationShape o, List<HttpBinding> b) {
        throw schemaOnly();
    }

    @Override
    protected void deserializeOutputDocumentBody(GenerationContext c, OperationShape o, List<HttpBinding> b) {
        throw schemaOnly();
    }

    @Override
    protected void deserializeErrorDocumentBody(GenerationContext c, StructureShape e, List<HttpBinding> b) {
        throw schemaOnly();
    }

    @Override
    protected boolean requiresNumericEpochSecondsInPayload() {
        return false;
    }
}
