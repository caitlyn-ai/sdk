package ai.caitlyn.codegen.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.shapes.ServiceShape;

/** The scope tree of the repository's own model (model/model.json): the places PROTOCOL.md 10 and the DX review name. */
class ScopeTreeTest {

    static ScopeTree tree;
    /** Every method's place: "caitlyn.knowledgeBases(knowledgeBaseId).documents.create" → "CreateDocument". */
    static final Map<String, String> places = new TreeMap<>();

    @BeforeAll
    static void load() throws Exception {
        Path file = Path.of("../../model/model.json");
        Model model = Model.assembler().discoverModels().addImport(file).assemble().unwrap();
        ServiceShape service = model.getServiceShapes().iterator().next();
        tree = ScopeTree.of(model, service);
        for (ScopeTree.Node n : tree.root.walk()) {
            for (ScopeTree.Method m : n.methods) {
                places.put(n.path() + "." + m.name, m.operation.getId().getName());
                m.estimate.ifPresent(e -> places.put(n.path() + "." + m.name + ".estimate", e.operation.getId().getName()));
            }
        }
        Path out = Path.of("build/scope-tree.json");
        Files.createDirectories(out.getParent());
        Files.writeString(out, Node.prettyPrintJson(tree.toNode()));
        List<String> lines = new ArrayList<>();
        places.forEach((k, v) -> lines.add(k + "  " + v));
        Files.write(Path.of("build/scope-tree.txt"), lines);
    }

    private static void at(String place, String operation) {
        assertEquals(operation, places.get(place), place + " (places: build/scope-tree.txt)");
    }

    @Test
    void theTenJobs() {
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents.create", "CreateDocument");
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).replace", "CreateDocumentVersion");
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).update", "UpdateDocument");
        at("caitlyn.knowledgeBases(knowledgeBaseId).folders(folderPath).access.set", "PutAccess");
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).access.set", "PutAccess");
        at("caitlyn.knowledgeBases(knowledgeBaseId).access.get", "GetAccess");
        at("caitlyn.agents.create", "CreateAgent");
        at("caitlyn.agents(agentId).draft.publish", "PublishAgentVersion");
        at("caitlyn.agents(agentId).draft.update", "UpdateDraftVersion");
        at("caitlyn.agents(agentId).draft.save", "SaveDraftVersion");
        at("caitlyn.agents(agentId).versions(version).publish", "PublishAgentVersion");
        at("caitlyn.agents(agentId).live.conversations.create", "CreateConversation");
        at("caitlyn.conversations(conversationId).send", "SendMessage");
        at("caitlyn.conversations(conversationId).watch", "WatchConversation");
        at("caitlyn.knowledgeBases(knowledgeBaseId).watch", "WatchKnowledgeBase");
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).delete", "DeleteDocument");
        at("caitlyn.knowledgeBases(knowledgeBaseId).folders(folderPath).delete", "DeleteFolder");
        at("caitlyn.knowledgeBases(knowledgeBaseId).delete", "DeleteKnowledgeBase");
        at("caitlyn.agents(agentId).delete", "DeleteAgent");
        at("caitlyn.knowledgeBases(knowledgeBaseId).fields.fillIn", "FillInFields");
        at("caitlyn.knowledgeBases(knowledgeBaseId).fields.fillIn.estimate", "EstimateFillInFields");
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents.create.estimate", "EstimateIngestion");
        at("caitlyn.knowledgeBases(knowledgeBaseId).layoutAwareSearch.enable.estimate", "EstimateLayoutAwareSearch");
    }

    @Test
    void theRestOfTheTree() {
        at("caitlyn.me", "GetCaller");
        at("caitlyn.agents.options.models", "ListModels");
        at("caitlyn.agents(agentId).history.list", "ListHistoryEntries");
        at("caitlyn.agents(agentId).history(historyEntryId).get", "GetHistoryEntry");
        at("caitlyn.agents(agentId).conversations.list", "ListConversations");
        at("caitlyn.conversations(conversationId).messages.list", "ListMessages");
        at("caitlyn.knowledgeBases(knowledgeBaseId).ingestion.batches(ingestionBatchId).start", "StartIngestionBatch");
        at("caitlyn.knowledgeBases(knowledgeBaseId).ingestion.batches(ingestionBatchId).items(itemId).resolve", "UpdateIngestionBatchItem");
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents(documentId).versions(version).get", "GetDocumentVersion");
        at("caitlyn.knowledgeBases(knowledgeBaseId).documents.deleteMany", "BatchDeleteDocuments");
        at("caitlyn.events.watch", "WatchWorkspaceEvents");
        at("caitlyn.core.uploads.reserve", "CreateUpload");
        at("caitlyn.core.uploads(uploadId).get", "GetUpload");
        at("caitlyn.core.ingestion.completeUploads", "CompleteIngestionBatchUploads");
        at("caitlyn.core.ingestion.addItems", "BatchCreateIngestionBatchItems");
        at("caitlyn.core.operations(knowledgeBaseId, operationId).get", "GetOperation");
        at("caitlyn.core.operations.list", "ListOperations");
    }

    @Test
    void namedScopes() {
        // live has no delete or publish; draft has no delete
        assertTrue(!places.containsKey("caitlyn.agents(agentId).live.publish"));
        assertTrue(!places.containsKey("caitlyn.agents(agentId).live.delete"));
        assertTrue(!places.containsKey("caitlyn.agents(agentId).draft.delete"));
        at("caitlyn.agents(agentId).live.get", "GetAgentVersion");
        at("caitlyn.agents(agentId).draft.get", "GetAgentVersion");
    }

    @Test
    void createsReturnScopes() {
        assertEquals("caitlyn.agents:output:agent.id", creates("caitlyn.agents", "create"));
        assertEquals("caitlyn.knowledgeBases(knowledgeBaseId).documents:output:document.id",
                creates("caitlyn.knowledgeBases(knowledgeBaseId).documents", "create"));
        // Bound to the agent's version, it makes a conversation: the scope caitlyn.conversations(id) reopens.
        assertEquals("caitlyn.conversations:output:conversation.id", creates("caitlyn.agents(agentId).live.conversations", "create"));
        assertEquals("caitlyn.conversations:output:conversation.id", creates("caitlyn.agents(agentId).versions(version).conversations", "create"));
    }

    private static String creates(String path, String method) {
        for (ScopeTree.Node n : tree.root.walk()) {
            if (!n.path().equals(path)) continue;
            for (ScopeTree.Method m : n.methods) {
                if (m.name.equals(method)) return m.creates.map(c -> c.collection().path() + ":" + c.source()).orElse("none");
            }
        }
        return "no method";
    }

    @Test
    void buildingBlocksTakeLeadingIdentifiers() {
        ScopeTree.Method add = tree.root.children.get("core").children.get("ingestion").methods.stream()
                .filter(m -> m.name.equals("addItems")).findFirst().orElseThrow();
        assertEquals(List.of("knowledgeBaseId", "ingestionBatchId"), add.leading);
    }
}
