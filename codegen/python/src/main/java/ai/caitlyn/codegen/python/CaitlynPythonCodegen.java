package ai.caitlyn.codegen.python;

import ai.caitlyn.codegen.model.CaitlynTraits;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.codegen.core.SymbolProvider;
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
import software.amazon.smithy.codegen.core.TopologicalIndex;
import software.amazon.smithy.model.neighbor.Walker;
import software.amazon.smithy.model.shapes.ShapeId;
import software.amazon.smithy.model.node.Node;
import software.amazon.smithy.model.shapes.EnumShape;
import software.amazon.smithy.model.shapes.IntEnumShape;
import software.amazon.smithy.model.shapes.MemberShape;
import software.amazon.smithy.model.shapes.Shape;
import software.amazon.smithy.model.shapes.ShapeType;
import software.amazon.smithy.model.shapes.StructureShape;
import software.amazon.smithy.model.shapes.UnionShape;
import software.amazon.smithy.model.traits.DefaultTrait;
import software.amazon.smithy.model.traits.DocumentationTrait;
import software.amazon.smithy.model.traits.ErrorTrait;
import software.amazon.smithy.model.traits.HttpErrorTrait;
import software.amazon.smithy.model.traits.HttpHeaderTrait;
import software.amazon.smithy.model.traits.JsonNameTrait;
import software.amazon.smithy.model.traits.RetryableTrait;

/**
 * Smithy's directed codegen drives this class over the service closure in dependency order:
 * structures become Pydantic models, enums open enums, errors exception classes, and SSE unions
 * typed event classes. {@link ServiceGenerator} writes the operations and clients.
 */
final class CaitlynPythonCodegen implements DirectedCodegen<GenerationContext, PythonSettings, PythonIntegration> {

    private final ModelFacts facts;

    CaitlynPythonCodegen(ModelFacts facts) {
        this.facts = facts;
    }

    @Override
    public SymbolProvider createSymbolProvider(CreateSymbolProviderDirective<PythonSettings> directive) {
        return new PythonSymbolProvider(directive.model(), directive.settings(), facts);
    }

    @Override
    public GenerationContext createContext(CreateContextDirective<PythonSettings, PythonIntegration> directive) {
        WriterDelegator<PythonWriter> delegator = new WriterDelegator<>(
                directive.fileManifest(), directive.symbolProvider(), (filename, namespace) -> new PythonWriter(namespace));
        return new GenerationContext(directive.model(), directive.settings(), directive.symbolProvider(),
                directive.fileManifest(), delegator, directive.integrations(), facts);
    }

    @Override
    public void generateService(GenerateServiceDirective<GenerationContext, PythonSettings> directive) {
        new ServiceGenerator(directive.context(), directive.shape()).run();
    }

    /**
     * SSE event unions are referenced only through the {@code @sseEvents} trait (an idRef), which
     * Smithy's walker does not follow, so they and the shapes only they reach are generated here,
     * in the same dependency order the director uses.
     */
    @Override
    public void customizeBeforeIntegrations(CustomizeDirective<GenerationContext, PythonSettings> directive) {
        GenerationContext ctx = directive.context();
        Model model = ctx.model();
        java.util.Set<Shape> extra = new java.util.HashSet<>();
        for (ShapeId id : facts.sseUnions) {
            extra.addAll(new Walker(model).walkShapes(model.expectShape(id)));
        }
        extra.removeIf(s -> directive.connectedShapes().containsKey(s.getId()));
        TopologicalIndex order = TopologicalIndex.of(model);
        List<Shape> ordered = new ArrayList<>();
        order.getOrderedShapes().stream().filter(extra::contains).forEach(ordered::add);
        order.getRecursiveShapes().stream().filter(extra::contains).filter(s -> !ordered.contains(s)).forEach(ordered::add);
        for (Shape s : ordered) {
            if (s.isStructureShape()) {
                if (s.hasTrait(ErrorTrait.class)) {
                    error(ctx, (StructureShape) s);
                } else {
                    structure(ctx, (StructureShape) s);
                }
            } else if (s.isEnumShape()) {
                enumShape(ctx, (EnumShape) s);
            } else if (s.isUnionShape()) {
                union(ctx, (UnionShape) s);
            }
        }
    }

    // ------------------------------------------------------------------ structures

    @Override
    public void generateStructure(GenerateStructureDirective<GenerationContext, PythonSettings> directive) {
        structure(directive.context(), directive.shape());
    }

    private void structure(GenerationContext ctx, StructureShape shape) {
        if (!facts.isGenerated(shape)) {
            return;
        }
        boolean result = facts.resultNames.containsKey(shape.getId());
        String className = ctx.symbolProvider().toSymbol(shape).getName();
        ctx.writerDelegator().useShapeWriter(shape, w -> {
            w.importFrom("caitlyn_core", "CaitlynModel");
            w.write("class $L(CaitlynModel):", className);
            w.indent();
            Optional<String> own = facts.inheritedDocs.contains(shape.getId()) ? Optional.empty() : docs(shape);
            String doc = own.orElse(result ? facts.resultDocs.getOrDefault(shape.getId(), "The result of the call.") : "");
            if (!doc.isEmpty()) {
                w.write("$D\n", doc);
            }
            List<MemberShape> members = new ArrayList<>(shape.getAllMembers().values());
            // Body members first, then the response headers a result is also read from.
            members.sort(java.util.Comparator.comparing((MemberShape m) -> m.hasTrait(HttpHeaderTrait.class)));
            writeFields(ctx, w, members, false);
            if (shape.getAllMembers().isEmpty() && doc.isEmpty()) {
                w.write("pass");
            }
            w.dedent();
            w.write("\n");
        });
    }

    /** Pydantic fields: snake_case names, explicit aliases only where the wire name is not their camelCase. */
    static void writeFields(GenerationContext ctx, PythonWriter w, Collection<MemberShape> members, boolean event) {
        Model model = ctx.model();
        TypeHints hints = new TypeHints(model, ctx.symbolProvider(), ctx.facts());
        for (MemberShape m : members) {
            String name = Names.field(m.getMemberName());
            if (event && name.equals("type")) {
                name = "type_"; // the event's `type` is its SSE event name
            }
            boolean header = m.hasTrait(HttpHeaderTrait.class);
            String wire = !header && m.hasTrait(JsonNameTrait.class) ? m.expectTrait(JsonNameTrait.class).getValue() : m.getMemberName();
            String type = hints.of(m, TypeHints.Mode.MODEL, w);
            Optional<String> dflt = defaultValue(model, m, w);
            boolean required = m.isRequired() || dflt.isPresent();
            List<String> fieldArgs = new ArrayList<>();
            String plainDefault = null;
            if (dflt.isPresent()) {
                if (dflt.get().startsWith("default_factory=")) {
                    fieldArgs.add(dflt.get());
                } else {
                    plainDefault = dflt.get();
                }
            } else if (!required) {
                type = type + " | None";
                plainDefault = "None";
            }
            if (!Names.camel(name).equals(wire)) {
                if (plainDefault != null) {
                    fieldArgs.add(0, "default=" + plainDefault);
                    plainDefault = null;
                }
                fieldArgs.add("validation_alias=" + Names.pyString(wire));
                fieldArgs.add("serialization_alias=" + Names.pyString(wire));
            }
            String line = name + ": " + type;
            if (!fieldArgs.isEmpty()) {
                w.importFrom("pydantic", "Field");
                line += " = Field(" + String.join(", ", fieldArgs) + ")";
            } else if (plainDefault != null) {
                line += " = " + plainDefault;
            }
            w.write("$L", line);
            String doc = memberDocs(m, header);
            if (!doc.isEmpty()) {
                w.write("$D", doc);
            }
        }
    }

    private static Optional<String> defaultValue(Model model, MemberShape m, PythonWriter w) {
        Optional<DefaultTrait> trait = m.getTrait(DefaultTrait.class);
        if (trait.isEmpty()) {
            return Optional.empty();
        }
        Node node = trait.get().toNode();
        Shape target = model.expectShape(m.getTarget());
        if (node.isNullNode()) {
            return Optional.empty();
        }
        if (target.isEnumShape() && node.isStringNode()) {
            EnumShape e = target.asEnumShape().get();
            String value = node.expectStringNode().getValue();
            for (Map.Entry<String, String> entry : e.getEnumValues().entrySet()) {
                if (entry.getValue().equals(value)) {
                    return Optional.of(e.getId().getName() + "." + entry.getKey());
                }
            }
        }
        if (node.isStringNode()) {
            return Optional.of(Names.pyString(node.expectStringNode().getValue()));
        }
        if (node.isBooleanNode()) {
            return Optional.of(node.expectBooleanNode().getValue() ? "True" : "False");
        }
        if (node.isNumberNode()) {
            return Optional.of(node.expectNumberNode().getValue().toString());
        }
        if (node.isArrayNode() && node.expectArrayNode().isEmpty()) {
            return Optional.of("default_factory=list");
        }
        if (node.isObjectNode() && node.expectObjectNode().isEmpty()) {
            return Optional.of("default_factory=dict");
        }
        throw new CodegenException("Unsupported default for " + m.getId() + ": " + Node.printJson(node));
    }

    static Optional<String> docs(Shape shape) {
        return shape.getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue).map(String::strip);
    }

    static String memberDocs(MemberShape m, boolean header) {
        StringBuilder out = new StringBuilder(docs(m).orElse(""));
        if (header) {
            appendSentence(out, "From the `" + m.expectTrait(HttpHeaderTrait.class).getValue() + "` response header.");
        }
        CaitlynTraits.since(m).ifPresent(v -> appendSentence(out, "Added in Caitlyn " + v + "."));
        return out.toString();
    }

    private static void appendSentence(StringBuilder out, String s) {
        if (out.length() > 0) {
            out.append(out.toString().contains("\n") ? "\n\n" : " ");
        }
        out.append(s);
    }

    // ------------------------------------------------------------------ errors

    @Override
    public void generateError(GenerateErrorDirective<GenerationContext, PythonSettings> directive) {
        error(directive.context(), directive.shape());
    }

    private void error(GenerationContext ctx, StructureShape shape) {
        String className = ctx.symbolProvider().toSymbol(shape).getName();
        TypeHints hints = new TypeHints(ctx.model(), ctx.symbolProvider(), facts);
        ctx.writerDelegator().useShapeWriter(shape, w -> {
            w.importFrom("caitlyn_core", "CaitlynError");
            w.importFrom("typing", "ClassVar");
            w.write("class $L(CaitlynError):", className);
            w.indent();
            String fault = shape.expectTrait(ErrorTrait.class).getValue();
            Optional<String> own = facts.inheritedDocs.contains(shape.getId()) ? Optional.empty() : docs(shape);
            String doc = own.orElse("A " + fault + " error (" + shape.getId().getName() + ").")
                    + "\n\nRaised for HTTP " + shape.getTrait(HttpErrorTrait.class).map(t -> String.valueOf(t.getCode())).orElse("errors")
                    + (shape.hasTrait(RetryableTrait.class) ? "; retried automatically when the operation is safe to repeat." : ".");
            w.write("$D\n", doc);
            shape.getTrait(HttpErrorTrait.class).ifPresent(t -> w.write("http_status: ClassVar[int | None] = $L", t.getCode()));
            shape.getTrait(RetryableTrait.class).ifPresent(t -> {
                w.write("retryable: ClassVar[bool] = True");
                if (t.getThrottling()) {
                    w.write("throttling: ClassVar[bool] = True");
                }
            });
            List<String> extra = new ArrayList<>();
            for (MemberShape m : shape.getAllMembers().values()) {
                if (facts.problemFields.contains(m.getMemberName())) {
                    continue;
                }
                boolean header = m.hasTrait(HttpHeaderTrait.class);
                String wire = header ? m.expectTrait(HttpHeaderTrait.class).getValue() : m.getMemberName();
                w.write("$L: $L | None = None", Names.member(m.getMemberName()), hints.of(m, TypeHints.Mode.MODEL, w));
                extra.add("(" + Names.pyString(Names.member(m.getMemberName())) + ", " + Names.pyString(header ? "header" : "body") + ", " + Names.pyString(wire) + ")");
            }
            if (!extra.isEmpty()) {
                w.write("members: ClassVar[tuple[tuple[str, str, str], ...]] = ($L,)", String.join(", ", extra));
            }
            w.dedent();
            w.write("\n");
        });
    }

    // ------------------------------------------------------------------ enums

    @Override
    public void generateEnumShape(GenerateEnumDirective<GenerationContext, PythonSettings> directive) {
        enumShape(directive.context(), directive.expectEnumShape());
    }

    private void enumShape(GenerationContext ctx, EnumShape shape) {
        String className = ctx.symbolProvider().toSymbol(shape).getName();
        ctx.writerDelegator().useShapeWriter(shape, w -> {
            w.importFrom("caitlyn_core", "OpenEnum");
            w.write("class $L(OpenEnum):", className);
            w.indent();
            String doc = docs(shape).orElse(shape.getId().getName() + ".")
                    + "\n\nOpen enum: a value this SDK version does not know is kept (its `is_known` is False).";
            w.write("$D\n", doc);
            for (MemberShape m : shape.getAllMembers().values()) {
                String value = shape.getEnumValues().get(m.getMemberName());
                w.write("$L = $L", m.getMemberName(), Names.pyString(value));
                docs(m).ifPresent(d -> w.write("$D", d));
            }
            w.dedent();
            w.write("\n");
        });
    }

    @Override
    public void generateIntEnumShape(GenerateIntEnumDirective<GenerationContext, PythonSettings> directive) {
        IntEnumShape shape = directive.shape().asIntEnumShape().orElseThrow();
        directive.context().writerDelegator().useShapeWriter(shape, w -> {
            w.importFrom("enum", "IntEnum");
            w.write("class $L(IntEnum):", directive.symbol().getName());
            w.indent();
            docs(shape).ifPresent(d -> w.write("$D\n", d));
            shape.getEnumValues().forEach((k, v) -> w.write("$L = $L", k, v));
            w.dedent();
            w.write("\n");
        });
    }

    // ------------------------------------------------------------------ unions (SSE events)

    @Override
    public void generateUnion(GenerateUnionDirective<GenerationContext, PythonSettings> directive) {
        union(directive.context(), directive.shape());
    }

    private void union(GenerationContext ctx, UnionShape union) {
        if (!facts.sseUnions.contains(union.getId())) {
            throw new CodegenException("Only unions named by @sseEvents are supported yet: " + union.getId());
        }
        Model model = ctx.model();
        ctx.writerDelegator().useShapeWriter(union, w -> {
            w.importFrom("caitlyn_core", "CaitlynEvent");
            w.importFrom("typing", "Literal");
            List<String> classes = new ArrayList<>();
            List<String> table = new ArrayList<>();
            for (MemberShape m : union.getAllMembers().values()) {
                String cls = facts.eventClassNames.get(m.getId());
                String wire = sseName(m);
                StructureShape target = model.expectShape(m.getTarget(), StructureShape.class);
                classes.add(cls);
                table.add(Names.pyString(wire) + ": " + cls);
                w.write("class $L(CaitlynEvent):", cls);
                w.indent();
                StringBuilder doc = new StringBuilder("The `" + wire + "` event.");
                docs(m).or(() -> docs(target)).ifPresent(d -> doc.append(" ").append(d));
                w.write("$D\n", doc.toString());
                writeFields(ctx, w, target.getAllMembers().values(), true);
                w.write("");
                w.write("@property");
                w.write("def type(self) -> Literal[$L]:", Names.pyString(wire));
                w.indent().write("$D", "The SSE event name.").write("return $L", Names.pyString(wire)).dedent();
                w.dedent();
                w.write("\n");
            }
            String name = ctx.symbolProvider().toSymbol(union).getName();
            w.importFrom("typing", "TypeAlias");
            w.importFrom("typing", "Final");
            w.write("$L: TypeAlias = $L", name, String.join(" | ", classes));
            w.write("$D\n", docs(union).orElse("Events on the stream.") + "\n\nEvent types this SDK version does not know are skipped.");
            w.write("$L_TYPES: Final[dict[str, type[$L]]] = {", Names.upperSnake(name), name);
            w.indent();
            table.forEach(t -> w.write("$L,", t));
            w.dedent();
            w.write("}\n");
        });
    }

    /** The SSE `event:` name: the member's jsonName, else its member name. */
    static String sseName(MemberShape m) {
        return m.getTrait(JsonNameTrait.class).map(JsonNameTrait::getValue).orElse(m.getMemberName());
    }

    static boolean isScalar(Shape s) {
        return s.getType().getCategory() == ShapeType.Category.SIMPLE;
    }
}
