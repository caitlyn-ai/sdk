package ai.caitlyn.codegen.rust;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.SymbolProvider;
import software.amazon.smithy.codegen.core.TopologicalIndex;
import software.amazon.smithy.codegen.core.WriterDelegator;
import software.amazon.smithy.codegen.core.directed.CreateContextDirective;
import software.amazon.smithy.codegen.core.directed.CreateSymbolProviderDirective;
import software.amazon.smithy.codegen.core.directed.CustomizeDirective;
import software.amazon.smithy.codegen.core.directed.DirectedCodegen;
import software.amazon.smithy.codegen.core.directed.GenerateEnumDirective;
import software.amazon.smithy.codegen.core.directed.GenerateErrorDirective;
import software.amazon.smithy.codegen.core.directed.GenerateIntEnumDirective;
import software.amazon.smithy.codegen.core.directed.GenerateServiceDirective;
import software.amazon.smithy.codegen.core.directed.GenerateStructureDirective;
import software.amazon.smithy.codegen.core.directed.GenerateUnionDirective;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.neighbor.Walker;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.shapes.EnumShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.DefaultTrait;
import software.amazon.smithy.model.traits.DocumentationTrait;
import software.amazon.smithy.model.traits.ErrorTrait;
import software.amazon.smithy.model.traits.HttpHeaderTrait;

/**
 * Smithy's directed codegen drives this class over the service closure: structures become serde structs that keep
 * their raw JSON, enums open Rust enums with an {@code Unknown(String)} variant, and SSE unions Rust enums of their
 * event structs. Errors become variants of the crate's Error enum, which {@link ServiceGenerator} writes with the
 * rest of the client.
 */
final class CaitlynRustCodegen implements DirectedCodegen<RustContext, RustSettings, RustContext.Integration> {

    static final String TYPES_PREAMBLE = "#![allow(clippy::doc_lazy_continuation, clippy::large_enum_variant)]\n\n"
            + "use caitlyn_sdk_core as rt;\nuse serde::{Deserialize, Deserializer, Serialize, Serializer};\n\n";

    private final ModelFacts facts;
    private final Set<ShapeId> done = new HashSet<>();
    private RustTypes types;

    CaitlynRustCodegen(ModelFacts facts) {
        this.facts = facts;
    }

    @Override
    public SymbolProvider createSymbolProvider(CreateSymbolProviderDirective<RustSettings> directive) {
        types = new RustTypes(directive.model(), facts);
        return types;
    }

    @Override
    public RustContext createContext(CreateContextDirective<RustSettings, RustContext.Integration> directive) {
        WriterDelegator<RustWriter> delegator = new WriterDelegator<>(directive.fileManifest(), directive.symbolProvider(),
                (filename, namespace) -> new RustWriter(filename.endsWith("types.rs") ? TYPES_PREAMBLE : ""));
        return new RustContext(directive.model(), directive.settings(), directive.symbolProvider(), directive.fileManifest(),
                delegator, directive.integrations(), facts, types);
    }

    @Override
    public void generateService(GenerateServiceDirective<RustContext, RustSettings> directive) {
        new ServiceGenerator(directive.context(), directive.shape()).run();
    }

    /**
     * SSE unions are referenced only through @sseEvents (an idRef the walker does not follow), so they and the
     * shapes only they reach are generated here.
     */
    @Override
    public void customizeBeforeIntegrations(CustomizeDirective<RustContext, RustSettings> directive) {
        RustContext ctx = directive.context();
        Model model = ctx.model();
        Set<Shape> extra = new HashSet<>();
        for (ShapeId id : facts.sseUnions) {
            extra.addAll(new Walker(model).walkShapes(model.expectShape(id)));
        }
        extra.removeIf(s -> directive.connectedShapes().containsKey(s.getId()));
        TopologicalIndex order = TopologicalIndex.of(model);
        List<Shape> ordered = new ArrayList<>();
        order.getOrderedShapes().stream().filter(extra::contains).forEach(ordered::add);
        order.getRecursiveShapes().stream().filter(extra::contains).filter(s -> !ordered.contains(s)).forEach(ordered::add);
        for (Shape s : ordered) {
            if (s.isStructureShape() && !s.hasTrait(ErrorTrait.class)) {
                structure(ctx, (StructureShape) s);
            } else if (s.isEnumShape()) {
                enumShape(ctx, (EnumShape) s);
            } else if (s.isUnionShape()) {
                union(ctx, (UnionShape) s);
            }
        }
    }

    // ------------------------------------------------------------------ structures

    @Override
    public void generateStructure(GenerateStructureDirective<RustContext, RustSettings> directive) {
        structure(directive.context(), directive.shape());
    }

    private void structure(RustContext ctx, StructureShape shape) {
        if (!facts.isGenerated(shape) || !done.add(shape.getId())) {
            return;
        }
        String name = ctx.symbolProvider().toSymbol(shape).getName();
        boolean event = facts.sseMemberOf.containsKey(shape.getId());
        ctx.writerDelegator().useFileWriter("src/types.rs", "", w -> {
            w.l(Names.doc(doc(shape), ""));
            if (facts.resultNames.containsKey(shape.getId())) {
                w.l("///\n/// Header-bound members are filled from the response headers; `raw` holds the body as received.\n");
            }
            w.l("#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]\n#[serde(remote = \"Self\", default)]\n");
            w.l("pub struct " + name + " {\n");
            for (MemberShape m : shape.getAllMembers().values()) {
                checkDefault(m);
                String field = Names.snake(m.getMemberName());
                if (field.equals("raw") || field.equals("event_id")) {
                    throw new CodegenException(m.getId() + ": a member named " + field + " clashes with the generated field");
                }
                w.l(Names.doc(memberDoc(ctx, m), "    "));
                if (m.hasTrait(HttpHeaderTrait.class)) {
                    w.l("    ///\n    /// From the `" + m.expectTrait(HttpHeaderTrait.class).getValue() + "` response header.\n");
                    w.l("    #[serde(skip)]\n");
                } else {
                    w.l("    #[serde(rename = " + Names.str(ModelFacts.wireName(m)) + ctx.types().serdeExtra(m) + ")]\n");
                }
                w.l("    pub " + field + ": " + ctx.types().member(m) + ",\n");
            }
            if (event) {
                w.l("    /// The event's SSE `id:`.\n    #[serde(skip)]\n    pub event_id: Option<String>,\n");
            }
            w.l("    /// The JSON object this value was read from, unknown fields included (PROTOCOL.md 4.1). Empty on values\n"
                    + "    /// you build yourself.\n    #[serde(skip)]\n    pub raw: rt::Raw,\n}\n\n");
            w.l("impl Serialize for " + name + " {\n    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {\n"
                    + "        " + name + "::serialize(self, s)\n    }\n}\n\n");
            w.l("impl<'de> Deserialize<'de> for " + name + " {\n    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {\n"
                    + "        let v = serde_json::Value::deserialize(d)?;\n"
                    + "        rt::raw::with_raw(v, |v| " + name + "::deserialize(v), |o, r| o.raw = r)\n    }\n}\n\n");
        });
    }

    static String memberDoc(RustContext ctx, MemberShape m) {
        return m.getMemberTrait(ctx.model(), DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
    }

    /** A member's default must be what Rust's Default gives (serde fills absent members with it). */
    private static void checkDefault(MemberShape m) {
        m.getTrait(DefaultTrait.class).ifPresent(d -> {
            Node v = d.toNode();
            boolean zero = v.isNullNode()
                    || v.asStringNode().map(s -> s.getValue().isEmpty()).orElse(false)
                    || v.asBooleanNode().map(b -> !b.getValue()).orElse(false)
                    || v.asNumberNode().map(n -> n.getValue().doubleValue() == 0).orElse(false)
                    || v.asArrayNode().map(a -> a.isEmpty()).orElse(false)
                    || v.asObjectNode().map(o -> o.isEmpty()).orElse(false);
            if (!zero && m.isRequired()) {
                throw new CodegenException(m.getId() + ": a non-zero @default on a required member is not supported yet");
            }
        });
    }

    static String doc(Shape s) {
        return s.getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
    }

    // ------------------------------------------------------------------ errors

    /** Error shapes become variants of the Error enum (ServiceGenerator); this checks they need nothing more. */
    @Override
    public void generateError(GenerateErrorDirective<RustContext, RustSettings> directive) {
        for (MemberShape m : directive.shape().getAllMembers().values()) {
            if (!facts.problemFields.contains(m.getMemberName())) {
                throw new CodegenException(m.getId() + ": error members beyond the problem-details fields are not supported yet");
            }
        }
    }

    // ------------------------------------------------------------------ enums

    @Override
    public void generateEnumShape(GenerateEnumDirective<RustContext, RustSettings> directive) {
        Shape s = directive.shape();
        if (!s.isEnumShape()) {
            throw new CodegenException(s.getId() + ": string shapes with @enum are not supported; use enum");
        }
        enumShape(directive.context(), (EnumShape) s);
    }

    private void enumShape(RustContext ctx, EnumShape shape) {
        if (!done.add(shape.getId())) {
            return;
        }
        String name = Names.pascal(shape.getId().getName());
        ctx.writerDelegator().useFileWriter("src/types.rs", "", w -> {
            w.l(Names.doc(doc(shape), ""));
            w.l("///\n/// Open: a value this SDK does not know yet is kept as [`" + name + "::Unknown`], never an error.\n");
            w.l("#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]\n#[non_exhaustive]\npub enum " + name + " {\n");
            List<String[]> values = new ArrayList<>();
            shape.getEnumValues().forEach((member, value) -> {
                String v = Names.pascal(member);
                if (v.equals("Unknown")) {
                    throw new CodegenException(shape.getId() + ": a value named unknown clashes with the open variant");
                }
                values.add(new String[] {v, value});
                w.l("    /// `" + value + "`\n    " + v + ",\n");
            });
            w.l("    /// A value this SDK does not know yet, as received.\n    Unknown(String),\n}\n\n");
            StringBuilder asStr = new StringBuilder();
            StringBuilder from = new StringBuilder();
            for (String[] v : values) {
                asStr.append("            ").append(name).append("::").append(v[0]).append(" => ").append(Names.str(v[1])).append(",\n");
                from.append("            ").append(Names.str(v[1])).append(" => ").append(name).append("::").append(v[0]).append(",\n");
            }
            w.l("impl " + name + " {\n    /// The value as sent on the wire.\n    pub fn as_str(&self) -> &str {\n        match self {\n" + asStr
                    + "            " + name + "::Unknown(s) => s,\n        }\n    }\n\n"
                    + "    /// Whether this SDK knows the value.\n    pub fn is_known(&self) -> bool {\n        !matches!(self, " + name
                    + "::Unknown(_))\n    }\n}\n\n");
            w.l("impl From<&str> for " + name + " {\n    fn from(s: &str) -> Self {\n        match s {\n" + from
                    + "            other => " + name + "::Unknown(other.to_owned()),\n        }\n    }\n}\n\n");
            w.l("impl From<String> for " + name + " {\n    fn from(s: String) -> Self {\n        " + name + "::from(s.as_str())\n    }\n}\n\n");
            w.l("impl Default for " + name + " {\n    fn default() -> Self {\n        " + name + "::Unknown(String::new())\n    }\n}\n\n");
            w.l("impl std::fmt::Display for " + name + " {\n    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {\n"
                    + "        f.write_str(self.as_str())\n    }\n}\n\n");
            w.l("impl Serialize for " + name + " {\n    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {\n"
                    + "        s.serialize_str(self.as_str())\n    }\n}\n\n");
            w.l("impl<'de> Deserialize<'de> for " + name + " {\n    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {\n"
                    + "        Ok(" + name + "::from(String::deserialize(d)?))\n    }\n}\n\n");
        });
    }

    @Override
    public void generateIntEnumShape(GenerateIntEnumDirective<RustContext, RustSettings> directive) {
        throw new CodegenException(directive.shape().getId() + ": intEnum is not supported yet");
    }

    // ------------------------------------------------------------------ unions

    @Override
    public void generateUnion(GenerateUnionDirective<RustContext, RustSettings> directive) {
        union(directive.context(), directive.shape());
    }

    private void union(RustContext ctx, UnionShape shape) {
        if (!done.add(shape.getId())) {
            return;
        }
        if (!facts.sseUnions.contains(shape.getId())) {
            throw new CodegenException(shape.getId() + ": unions outside @sseEvents are not supported yet");
        }
        String name = Names.pascal(shape.getId().getName());
        List<MemberShape> events = shape.getAllMembers().values().stream()
                .filter(m -> !facts.sseErrorTargets.contains(m.getTarget())).toList();
        ctx.writerDelegator().useFileWriter("src/types.rs", "", w -> {
            w.l(Names.doc(doc(shape), ""));
            w.l("///\n/// Event names this SDK does not know are skipped, and a failure event ends the stream with a typed error.\n");
            w.l("#[derive(Debug, Clone, PartialEq)]\n#[non_exhaustive]\npub enum " + name + " {\n");
            for (MemberShape m : events) {
                String t = ctx.symbolProvider().toSymbol(ctx.model().expectShape(m.getTarget())).getName();
                w.l("    /// `" + ModelFacts.wireName(m) + "`\n    " + t + "(" + t + "),\n");
            }
            w.l("}\n\n");
            w.l("impl " + name + " {\n    /// The event's SSE `id:`.\n    pub fn event_id(&self) -> Option<&str> {\n        match self {\n");
            for (MemberShape m : events) {
                String t = ctx.symbolProvider().toSymbol(ctx.model().expectShape(m.getTarget())).getName();
                w.l("            " + name + "::" + t + "(v) => v.event_id.as_deref(),\n");
            }
            w.l("        }\n    }\n}\n\n");
            w.l("/// Decodes one SSE event of the " + name + " union.\n");
            w.l("pub(crate) fn decode_" + Names.snake(shape.getId().getName()) + "(name: &str, id: Option<&str>, data: &[u8]) -> Result<rt::Decoded<"
                    + name + ">, serde_json::Error> {\n    Ok(match name {\n");
            for (MemberShape m : shape.getAllMembers().values()) {
                String wire = Names.str(ModelFacts.wireName(m));
                if (facts.sseErrorTargets.contains(m.getTarget())) {
                    w.l("        " + wire + " => rt::Decoded::Failure,\n");
                    continue;
                }
                String t = ctx.symbolProvider().toSymbol(ctx.model().expectShape(m.getTarget())).getName();
                w.l("        " + wire + " => {\n            let mut v: " + t + " = serde_json::from_slice(data)?;\n"
                        + "            v.event_id = id.map(str::to_owned);\n            rt::Decoded::Event(" + name + "::" + t + "(v))\n        }\n");
            }
            w.l("        _ => rt::Decoded::Skip,\n    })\n}\n\n");
        });
    }
}
