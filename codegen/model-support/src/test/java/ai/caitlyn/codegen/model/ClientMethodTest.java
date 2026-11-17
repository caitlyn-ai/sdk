package ai.caitlyn.codegen.model;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ShapeId;

class ClientMethodTest {
    private static final String MODEL = """
            $version: "2"
            namespace ai.caitlyn.v3

            resource KnowledgeBase {
                identifiers: { knowledgeBaseId: String }
                resources: [DocumentResource]
            }
            resource DocumentResource {
                identifiers: { knowledgeBaseId: String, documentId: String }
                resources: [DocumentVersion]
                create: CreateDocument
            }
            resource DocumentVersion {
                identifiers: { knowledgeBaseId: String, documentId: String, version: String }
                read: GetDocumentVersion
            }
            resource IngestionBatch {
                identifiers: { ingestionBatchId: String }
                resources: [IngestionBatchItem]
                operations: [StartIngestionBatch]
            }
            resource IngestionBatchItem {
                identifiers: { ingestionBatchId: String, itemId: String }
                list: ListIngestionBatchItems
            }
            @http(method: "POST", uri: "/kb/{knowledgeBaseId}/documents")
            operation CreateDocument { input := { @required @httpLabel knowledgeBaseId: String } }
            @readonly @http(method: "GET", uri: "/kb/{knowledgeBaseId}/documents/{documentId}/versions/{version}")
            operation GetDocumentVersion {
                input := { @required @httpLabel knowledgeBaseId: String, @required @httpLabel documentId: String, @required @httpLabel version: String }
            }
            @http(method: "POST", uri: "/b/{ingestionBatchId}/start")
            operation StartIngestionBatch { input := { @required @httpLabel ingestionBatchId: String } }
            @readonly @http(method: "GET", uri: "/b/{ingestionBatchId}/items")
            operation ListIngestionBatchItems { input := { @required @httpLabel ingestionBatchId: String } }
            """;

    private static ClientMethod method(String name) {
        Model model = Model.assembler().addUnparsedModel("test.smithy", MODEL).assemble().unwrap();
        return ClientMethod.of(model, model.expectShape(ShapeId.from("ai.caitlyn.v3#" + name), OperationShape.class));
    }

    @Test
    void namespacesFollowTheResourceTree() {
        assertEquals("knowledgeBases.documents", method("CreateDocument").namespace());
        // A child named after its parent drops the parent's part: DocumentVersion is versions, not documentVersions.
        assertEquals("knowledgeBases.documents.versions", method("GetDocumentVersion").namespace());
        assertEquals("ingestionBatches.items", method("ListIngestionBatchItems").namespace());
        assertEquals("ingestionBatches", method("StartIngestionBatch").namespace());
        assertEquals("start", method("StartIngestionBatch").method());
        assertEquals("ingestionBatchId", method("StartIngestionBatch").positionalMember().orElseThrow());
    }

    @Test
    void plurals() {
        assertEquals("batches", ClientMethod.plural("Batch"));
        assertEquals("policies", ClientMethod.plural("Policy"));
        assertEquals("keys", ClientMethod.plural("Key"));
        assertEquals("boxes", ClientMethod.plural("Box"));
        assertEquals("liveHistoryEntries", ClientMethod.plural("LiveHistoryEntry"));
    }
}
