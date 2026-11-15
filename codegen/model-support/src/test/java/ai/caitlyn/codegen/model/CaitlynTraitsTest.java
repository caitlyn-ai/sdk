package ai.caitlyn.codegen.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ShapeId;

class CaitlynTraitsTest {
    private static final String MODEL = """
            $version: "2"
            namespace ai.caitlyn.traits

            @trait(selector: "operation")
            map waitLimits {
                key: String
                value: Integer
            }

            @smithy.waiters#waitable(
                Indexed: { acceptors: [{ state: "success", matcher: { success: true } }] }
                Deleted: { acceptors: [{ state: "success", matcher: { success: true } }] }
            )
            @waitLimits(Indexed: 3600)
            operation GetDocument {}

            operation GetAgentVersion {}

            @smithy.waiters#waitable(
                Ready: { acceptors: [{ state: "success", matcher: { success: true } }] }
            )
            @waitLimits(Redy: 600)
            operation GetUpload {}
            """;

    private static OperationShape op(String name) {
        Model model = Model.assembler(CaitlynTraitsTest.class.getClassLoader()).discoverModels(CaitlynTraitsTest.class.getClassLoader())
                .addUnparsedModel("test.smithy", MODEL).assemble().unwrap();
        return model.expectShape(ShapeId.from("ai.caitlyn.traits#" + name), OperationShape.class);
    }

    @Test
    void aWaiterWithAnEntryUsesIt() {
        assertEquals(3600, CaitlynTraits.waitLimitSeconds(op("GetDocument"), "Indexed"));
    }

    @Test
    void aWaiterWithoutAnEntryWaitsFiveMinutes() {
        assertEquals(300, CaitlynTraits.waitLimitSeconds(op("GetDocument"), "Deleted"));
        assertEquals(300, CaitlynTraits.waitLimitSeconds(op("GetAgentVersion"), "Ready"));
    }

    @Test
    void anEntryForAWaiterTheOperationDoesNotHaveFails() {
        CodegenException e = assertThrows(CodegenException.class, () -> CaitlynTraits.waitLimitSeconds(op("GetUpload"), "Ready"));
        assertEquals("ai.caitlyn.traits#GetUpload: @waitLimits names Redy, which is not one of its waiters", e.getMessage());
    }
}
