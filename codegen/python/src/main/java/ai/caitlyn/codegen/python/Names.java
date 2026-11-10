package ai.caitlyn.codegen.python;

import java.util.Set;

/** Python naming: snake_case members and methods, reserved words, and Pydantic's own attributes. */
final class Names {

    private static final Set<String> KEYWORDS = Set.of(
            "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
            "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
            "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
            "match", "case");

    /** Attributes of pydantic.BaseModel and CaitlynModel that a field must not shadow. */
    private static final Set<String> MODEL_RESERVED = Set.of(
            "raw", "to_wire", "from_wire", "copy", "dict", "json", "schema", "construct", "validate",
            "parse_obj", "parse_raw", "fields", "model_config", "model_fields", "event_id");

    private Names() {}

    /** knowledgeBaseId -> knowledge_base_id; sha256 -> sha256; HTTPServer -> http_server. */
    static String snake(String name) {
        StringBuilder out = new StringBuilder();
        char[] c = name.toCharArray();
        for (int i = 0; i < c.length; i++) {
            char ch = c[i];
            if (Character.isUpperCase(ch)) {
                boolean prevLower = i > 0 && (Character.isLowerCase(c[i - 1]) || Character.isDigit(c[i - 1]));
                boolean nextLower = i + 1 < c.length && Character.isLowerCase(c[i + 1]);
                boolean prevUpper = i > 0 && Character.isUpperCase(c[i - 1]);
                if (i > 0 && (prevLower || (prevUpper && nextLower)) && out.charAt(out.length() - 1) != '_') {
                    out.append('_');
                }
                out.append(Character.toLowerCase(ch));
            } else if (ch == '-' || ch == '.' || ch == ' ') {
                out.append('_');
            } else {
                out.append(ch);
            }
        }
        return out.toString();
    }

    /** The inverse used by caitlyn_core.camel(): knowledge_base_id -> knowledgeBaseId. */
    static String camel(String snake) {
        String s = snake.replaceAll("_+$", "");
        String[] parts = s.split("_");
        StringBuilder out = new StringBuilder(parts[0]);
        for (int i = 1; i < parts.length; i++) {
            if (!parts[i].isEmpty()) {
                out.append(Character.toUpperCase(parts[i].charAt(0))).append(parts[i].substring(1));
            }
        }
        return out.toString();
    }

    static String upperSnake(String name) {
        return snake(name).toUpperCase();
    }

    /** A Python identifier for a parameter or attribute. */
    static String member(String modelName) {
        String n = snake(modelName);
        return KEYWORDS.contains(n) ? n + "_" : n;
    }

    /** As member(), also avoiding the base model's own attributes. */
    static String field(String modelName) {
        String n = member(modelName);
        return MODEL_RESERVED.contains(n) ? n + "_" : n;
    }

    static String pyString(String s) {
        StringBuilder out = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case '\\' -> out.append("\\\\");
                case '"' -> out.append("\\\"");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> out.append(ch);
            }
        }
        return out.append('"').toString();
    }
}
