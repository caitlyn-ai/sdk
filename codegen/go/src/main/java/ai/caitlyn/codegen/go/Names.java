package ai.caitlyn.codegen.go;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Go naming: exported identifiers with Go's initialisms, unexported parameters, string literals, doc comments. */
final class Names {

    private static final Set<String> KEYWORDS = Set.of(
            "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func",
            "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct",
            "switch", "type", "var", "ctx", "in", "opts", "c", "err", "req", "resp", "out");

    /** Words Go writes in one case throughout (golint's list, plus the model's own). */
    private static final Map<String, String> INITIALISMS = Map.ofEntries(
            Map.entry("id", "ID"), Map.entry("ids", "IDs"), Map.entry("url", "URL"), Map.entry("uri", "URI"),
            Map.entry("api", "API"), Map.entry("http", "HTTP"), Map.entry("https", "HTTPS"), Map.entry("json", "JSON"),
            Map.entry("sha256", "SHA256"), Map.entry("etag", "ETag"), Map.entry("uuid", "UUID"), Map.entry("sse", "SSE"),
            Map.entry("ip", "IP"), Map.entry("html", "HTML"), Map.entry("sql", "SQL"), Map.entry("ttl", "TTL"),
            Map.entry("oauth", "OAuth"), Map.entry("kms", "KMS"));

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

    /** knowledgeBaseId -> KnowledgeBaseID; sha256 -> SHA256; PARTIALLY_INDEXED -> PartiallyIndexed. */
    static String exported(String name) {
        StringBuilder out = new StringBuilder();
        for (String w : words(name)) {
            String i = INITIALISMS.get(w);
            out.append(i != null ? i : Character.toUpperCase(w.charAt(0)) + w.substring(1));
        }
        return out.toString();
    }

    /** conversationId -> conversationID, for parameters. */
    static String unexported(String name) {
        List<String> ws = words(name);
        StringBuilder out = new StringBuilder(ws.get(0));
        for (int i = 1; i < ws.size(); i++) {
            String w = ws.get(i);
            String in = INITIALISMS.get(w);
            out.append(in != null ? in : Character.toUpperCase(w.charAt(0)) + w.substring(1));
        }
        String n = out.toString();
        return KEYWORDS.contains(n) ? n + "_" : n;
    }

    static String lowerFirst(String s) {
        return s.isEmpty() ? s : Character.toLowerCase(s.charAt(0)) + s.substring(1);
    }

    /** A Go interpreted string literal. */
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
     * A Go doc comment for identifier {@code name}: Go wants it to start with the name, so a model sentence
     * such as "Lists the documents…" becomes "List lists the documents…" for methods, and "Document: One
     * document…" for types whose sentence cannot follow the name.
     */
    static String doc(String name, String text, boolean verbPhrase, String indent) {
        String t = text == null ? "" : text.strip();
        String first;
        if (t.isEmpty()) {
            first = name + " is generated from the Caitlyn model.";
        } else if (verbPhrase) {
            first = name + " " + lowerFirst(t);
        } else if (t.matches("^(The|A|An) .*")) {
            first = name + " is " + lowerFirst(t);
        } else {
            first = name + ": " + t;
        }
        return comment(first, indent);
    }

    /** Wraps text as // lines at about 100 columns; blank lines in the text become "//". */
    static String comment(String text, String indent) {
        StringBuilder out = new StringBuilder();
        for (String para : text.strip().split("\n")) {
            String p = para.strip();
            if (p.isEmpty()) {
                out.append(indent).append("//\n");
                continue;
            }
            StringBuilder line = new StringBuilder();
            for (String word : p.split("\\s+")) {
                if (line.length() + word.length() + 1 > 100 && line.length() > 0) {
                    out.append(indent).append("// ").append(line).append('\n');
                    line.setLength(0);
                }
                if (line.length() > 0) {
                    line.append(' ');
                }
                line.append(word);
            }
            out.append(indent).append("// ").append(line).append('\n');
        }
        return out.toString();
    }
}
