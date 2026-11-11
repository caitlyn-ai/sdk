package ai.caitlyn.codegen.rust;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** Rust naming (RFC 430): UpperCamelCase types and variants, snake_case fields and methods; literals and doc comments. */
final class Names {

    /** Keywords a raw identifier (r#type) can stand for. */
    private static final Set<String> KEYWORDS = Set.of(
            "as", "async", "await", "break", "const", "continue", "dyn", "else", "enum", "extern", "false", "fn", "for",
            "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "static", "struct",
            "trait", "true", "type", "unsafe", "use", "where", "while", "abstract", "become", "box", "do", "final", "gen",
            "macro", "override", "priv", "try", "typeof", "unsized", "virtual", "yield");

    /** Keywords that cannot be raw identifiers, and names generated code uses for its own locals. */
    private static final Set<String> RESERVED = Set.of("self", "super", "crate", "Self", "input", "opts", "core", "req", "resp", "out", "this");

    private Names() {}

    /** Splits camelCase, PascalCase, UPPER_SNAKE and dotted names into lower-case words. */
    static List<String> words(String name) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        char[] c = name.toCharArray();
        for (int i = 0; i < c.length; i++) {
            char ch = c[i];
            if (ch == '_' || ch == '-' || ch == '.' || ch == ' ' || ch == '/') {
                flush(out, cur);
                continue;
            }
            if (Character.isUpperCase(ch) && cur.length() > 0) {
                boolean prevLower = Character.isLowerCase(c[i - 1]) || Character.isDigit(c[i - 1]);
                boolean nextLower = i + 1 < c.length && Character.isLowerCase(c[i + 1]);
                boolean prevUpper = Character.isUpperCase(c[i - 1]);
                if (prevLower || (prevUpper && nextLower)) {
                    flush(out, cur);
                }
            }
            cur.append(Character.toLowerCase(ch));
        }
        flush(out, cur);
        return out;
    }

    private static void flush(List<String> out, StringBuilder cur) {
        if (cur.length() > 0) {
            out.add(cur.toString());
            cur.setLength(0);
        }
    }

    /** knowledgeBaseId -> KnowledgeBaseId; PARTIALLY_INDEXED -> PartiallyIndexed; message.started -> MessageStarted. */
    static String pascal(String name) {
        StringBuilder out = new StringBuilder();
        for (String w : words(name)) {
            out.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        String s = out.toString();
        return s.isEmpty() || Character.isDigit(s.charAt(0)) ? "V" + s : s;
    }

    /** knowledgeBaseId -> knowledge_base_id; type -> r#type; self -> self_. */
    static String snake(String name) {
        String s = String.join("_", words(name));
        if (s.isEmpty() || Character.isDigit(s.charAt(0))) {
            s = "v_" + s;
        }
        if (RESERVED.contains(s)) {
            return s + "_";
        }
        return KEYWORDS.contains(s) ? "r#" + s : s;
    }

    /** UPPER_SNAKE for constants: GetAgentVersion -> GET_AGENT_VERSION. */
    static String constant(String name) {
        return String.join("_", words(name)).toUpperCase(java.util.Locale.ROOT);
    }

    /** A Rust string literal. */
    static String str(String s) {
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

    /**
     * Rustdoc lines ({@code ///}) for text, wrapped at about 100 columns. Fenced code without a language becomes
     * {@code text}, so model prose never runs as a doctest.
     */
    static String doc(String text, String indent) {
        return comment(text, indent, "///");
    }

    /** Inner doc lines ({@code //!}). */
    static String innerDoc(String text) {
        return comment(text, "", "//!");
    }

    private static String comment(String text, String indent, String marker) {
        if (text == null || text.isBlank()) {
            return "";
        }
        StringBuilder out = new StringBuilder();
        boolean fenced = false;
        for (String para : text.strip().split("\n")) {
            String p = para.strip();
            if (p.startsWith("```")) {
                out.append(indent).append(marker).append(' ').append(!fenced && p.equals("```") ? "```text" : p).append('\n');
                fenced = !fenced;
                continue;
            }
            if (fenced) {
                out.append(indent).append(marker).append(' ').append(para.stripTrailing()).append('\n');
                continue;
            }
            if (p.isEmpty()) {
                out.append(indent).append(marker).append('\n');
                continue;
            }
            StringBuilder line = new StringBuilder();
            for (String word : p.split("\\s+")) {
                if (line.length() + word.length() + 1 > 100 && line.length() > 0) {
                    out.append(indent).append(marker).append(' ').append(line).append('\n');
                    line.setLength(0);
                }
                if (line.length() > 0) {
                    line.append(' ');
                }
                line.append(word);
            }
            out.append(indent).append(marker).append(' ').append(line).append('\n');
        }
        return out.toString();
    }
}
