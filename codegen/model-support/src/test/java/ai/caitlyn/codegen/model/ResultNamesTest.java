package ai.caitlyn.codegen.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.shapes.ServiceShape;
import software.amazon.smithy.model.shapes.ShapeId;

/** One type per thing, on the repository's own model (model/model.json). */
class ResultNamesTest {

    static Model model;
    static ResultNames names;
    static OperationIndex ops;

    @BeforeAll
    static void load() {
        model = Model.assembler().discoverModels().addImport(Path.of("../../model/model.json")).assemble().unwrap();
        ServiceShape service = model.getServiceShapes().iterator().next();
        names = new ResultNames(model, service, UnaryOperator.identity());
        ops = OperationIndex.of(model);
    }

    private static ShapeId output(String op) {
        return ops.expectOutputShape(ShapeId.from("ai.caitlyn.v3#" + op)).getId();
    }

    @Test
    void aCallThatGivesAThingReturnsTheThingsOwnType() {
        for (String[] c : List.of(
                new String[] {"GetKnowledgeBase", "KnowledgeBase"},
                new String[] {"UpdateKnowledgeBase", "KnowledgeBase"},
                new String[] {"GetDocument", "Document"},
                new String[] {"GetIngestionBatch", "IngestionBatch"},
                new String[] {"GetAgent", "Agent"},
                new String[] {"GetAgentVersion", "AgentVersion"})) {
            ShapeId out = output(c[0]);
            assertTrue(names.returnsThing(out), c[0] + " returns a thing");
            assertEquals(c[1], model.expectShape(names.payloadOf(out).orElseThrow().getTarget()).getId().getName(), c[0]);
            assertFalse(names.names().containsKey(out), c[0] + " has no result name of its own");
        }
    }

    @Test
    void anOutputThatIsNotAThingKeepsItsName() {
        for (String op : List.of("EstimateIngestion", "PublishAgentVersion", "StartIngestionBatch", "BatchDeleteDocuments")) {
            ShapeId out = output(op);
            assertFalse(names.returnsThing(out), op + " is not a thing");
            assertTrue(names.names().containsKey(out), op + " keeps a name");
        }
    }

    @Test
    void aListsPageKeepsItsName() {
        ShapeId out = output("ListKnowledgeBases");
        assertFalse(names.returnsThing(out));
        assertEquals("ListKnowledgeBasesPage", names.names().get(out));
    }
}
