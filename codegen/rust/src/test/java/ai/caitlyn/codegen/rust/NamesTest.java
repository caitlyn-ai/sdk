package ai.caitlyn.codegen.rust;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class NamesTest {

    @Test
    void rustCase() {
        assertEquals("knowledge_base_id", Names.snake("knowledgeBaseId"));
        assertEquals("r#type", Names.snake("type"));
        assertEquals("self_", Names.snake("self"));
        assertEquals("sha256", Names.snake("sha256"));
        assertEquals("PartiallyIndexed", Names.pascal("PARTIALLY_INDEXED"));
        assertEquals("MessageStarted", Names.pascal("message.started"));
        assertEquals("GET_AGENT_VERSION", Names.constant("GetAgentVersion"));
    }

    @Test
    void fencedModelProseNeverRunsAsADoctest() {
        assertEquals("/// Example:\n/// ```text\n/// a b\n/// ```\n", Names.doc("Example:\n```\na b\n```", ""));
    }
}
