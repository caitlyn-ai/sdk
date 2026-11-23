package ai.caitlyn.codegen.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import software.amazon.smithy.model.Model;

/** The @range rules each request carries (PROTOCOL.md 3), on the repository's own model (model/model.json). */
class RangesTest {

    static Map<String, List<Ranges.Rule>> rules;

    @BeforeAll
    static void load() {
        Model model = Model.assembler().discoverModels().addImport(Path.of("../../model/model.json")).assemble().unwrap();
        rules = Ranges.of(model, model.getServiceShapes().iterator().next().getId());
    }

    private static Ranges.Rule rule(String op, String path) {
        return rules.get(op).stream().filter(r -> r.path().equals(path)).findFirst().orElseThrow(() -> new AssertionError(op + " " + path));
    }

    @Test
    void aQueryParameterIsNamedAsItIsSent() {
        Ranges.Rule limit = rule("ListDocuments", "limit");
        assertEquals("query", limit.where());
        assertEquals(Optional.of(BigDecimal.ONE), limit.min());
        assertEquals(Optional.of(BigDecimal.valueOf(100)), limit.max());
    }

    @Test
    void aBodyValueIsAPointerAndListItemsAreAStar() {
        assertEquals("body", rule("CreateUpload", "/expiresInSeconds").where());
        assertEquals(Optional.empty(), rule("BatchCreateIngestionBatchItems", "/items/*/byteSize").max());
    }

    @Test
    void anOperationWithNoRangesHasNoEntry() {
        assertTrue(!rules.containsKey("GetCaller"));
    }

    @Test
    void boundsAreWrittenPlainly() {
        assertEquals("1", Ranges.number(new BigDecimal("1.0")));
        assertEquals("0.5", Ranges.number(new BigDecimal("0.50")));
        assertEquals("16384", Ranges.number(new BigDecimal("1.6384E+4")));
    }
}
