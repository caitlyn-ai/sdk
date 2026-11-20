package ai.caitlyn.codegen.go;

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
import software.amazon.smithy.model.traits.HttpErrorTrait;
import software.amazon.smithy.model.traits.HttpHeaderTrait;

/**
 * Smithy's directed codegen drives this class over the service closure: structures become Go structs that
 * keep their raw JSON, enums open string types, errors types that embed the runtime's *core.APIError, and
 * SSE unions sealed interfaces implemented by their event structs. {@link ServiceGenerator} writes the rest.
 */
final class CaitlynGoCodegen implements DirectedCodegen<GoContext, GoSettings, GoContext.Integration> {

    private final ModelFacts facts;
    private final Set<ShapeId> done = new HashSet<>();
    private final Set<String> processingDone = new HashSet<>();
    private GoTypes types;

    CaitlynGoCodegen(ModelFacts facts) {
        this.facts = facts;
    }

    @Override
    public SymbolProvider createSymbolProvider(CreateSymbolProviderDirective<GoSettings> directive) {
        types = new GoTypes(directive.model(), facts);
        return types;
    }

    @Override
    public GoContext createContext(CreateContextDirective<GoSettings, GoContext.Integration> directive) {
        WriterDelegator<GoWriter> delegator = new WriterDelegator<>(directive.fileManifest(), directive.symbolProvider(),
                (filename, namespace) -> new GoWriter(directive.settings().packageName()));
        return new GoContext(directive.model(), directive.settings(), directive.symbolProvider(), directive.fileManifest(),
                delegator, directive.integrations(), facts, types);
    }

    @Override
    public void generateService(GenerateServiceDirective<GoContext, GoSettings> directive) {
        new ServiceGenerator(directive.context(), directive.shape()).run();
    }

    /**
     * SSE unions are referenced only through @sseEvents (an idRef the walker does not follow), so they and
     * the shapes only they reach are generated here.
     */
    @Override
    public void customizeBeforeIntegrations(CustomizeDirective<GoContext, GoSettings> directive) {
        GoContext ctx = directive.context();
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
    public void generateStructure(GenerateStructureDirective<GoContext, GoSettings> directive) {
        structure(directive.context(), directive.shape());
    }

    private void structure(GoContext ctx, StructureShape shape) {
        if (!facts.isGenerated(shape) || !done.add(shape.getId())) {
            return;
        }
        String name = ctx.symbolProvider().toSymbol(shape).getName();
        List<ShapeId> unions = facts.sseMemberOf.getOrDefault(shape.getId(), List.of()).stream().distinct().toList();
        boolean thing = facts.things.contains(shape.getId());
        boolean result = facts.resultNames.containsKey(shape.getId()) || thing;
        // A page of a list (PROTOCOL.md 10): its cursor member, when the shape is a paginated operation's output
        java.util.Optional<String> pageCursor = ctx.model().getOperationShapesWithTrait(software.amazon.smithy.model.traits.PaginatedTrait.class).stream()
            .filter(o -> o.getOutputShape().equals(shape.getId()))
            .findFirst()
            .map(o -> software.amazon.smithy.model.knowledge.PaginatedIndex.of(ctx.model())
                .getPaginationInfo(ctx.settings().service(), o).orElseThrow().getOutputTokenMemberPath().get(0).getMemberName())
            .map(Names::exported);
        ctx.writerDelegator().useFileWriter("types.go", "", w -> {
            w.imp("encoding/json").imp(ctx.settings().coreModule());
            if (pageCursor.isPresent()) w.imp("context");
            w.l(Names.doc(name, doc(shape), false, ""));
            if (facts.resultNames.containsKey(shape.getId())) {
                w.l("//\n// Header-bound members are filled from the response headers; Raw holds the body as received.\n");
            } else if (thing) {
                w.l("//\n// Every call that gives a " + name + " returns this type, as do lists and watch snapshots. One read from a\n"
                        + "// single response (a get, an update, a create, a Wait) carries that response's ResponseMetadata, and its ETag\n"
                        + "// filled from the ETag header when the body has none; a list item or a snapshot entry carries no metadata.\n");
            }
            w.l("type " + name + " struct {\n");
            for (MemberShape m : shape.getAllMembers().values()) {
                checkDefault(m);
                String field = Names.exported(m.getMemberName());
                if (field.equals("Raw") || field.equals("RawJSON")) {
                    throw new CodegenException(m.getId() + ": a member named raw clashes with Raw()");
                }
                if (result && field.equals("ResponseMetadata")) {
                    throw new CodegenException(m.getId() + ": a member named responseMetadata clashes with ResponseMetadata()");
                }
                String text = m.getMemberTrait(ctx.model(), DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
                if (!text.isEmpty()) {
                    w.l(Names.comment(text, "\t"));
                }
                String type = ctx.types().member(m, w);
                String tag;
                if (m.hasTrait(HttpHeaderTrait.class)) {
                    tag = "-";
                    w.l("\t// From the " + m.expectTrait(HttpHeaderTrait.class).getValue() + " response header.\n");
                } else {
                    tag = ModelFacts.wireName(m) + (m.isRequired() ? "" : ServiceGenerator.omit(ctx.model().expectShape(m.getTarget())));
                }
                w.l("\t" + field + " " + type + " `json:\"" + tag + "\"`\n");
                String file = facts.fileFields.getOrDefault(shape.getId(), java.util.Map.of()).get(m.getMemberName());
                if (file != null) {
                    w.l(Names.comment("A file to upload in place of " + field + " (a Path, an *UploadFile or an UploadID): the operation "
                            + "that takes this structure uploads it and sends the upload's id as " + field + ". Set one of the two.", "\t"));
                    w.l("\t" + file + " File `json:\"-\"`\n");
                }
            }
            java.util.Set<String> eventNames = eventNames(ctx, shape, unions);
            if (!unions.isEmpty()) {
                w.l("\n\teventID string\n");
                if (eventNames.size() > 1) {
                    w.l("\teventType string\n");
                }
            }
            if (result) {
                w.l("\n\tmetadata core.ResponseMetadata\n");
            }
            if (pageCursor.isPresent()) {
                w.l("\tnextPage func(ctx context.Context) (*" + name + ", error)\n");
            }
            w.l("\n\traw core.Raw\n}\n\n");
            w.l("// UnmarshalJSON decodes the object and keeps it, unknown fields included, for Raw.\n");
            w.l("func (v *" + name + ") UnmarshalJSON(b []byte) error {\n\ttype plain " + name + "\n"
                    + "\tif err := json.Unmarshal(b, (*plain)(v)); err != nil {\n\t\treturn err\n\t}\n"
                    + "\tv.raw = core.NewRaw(b)\n\treturn nil\n}\n\n");
            w.l("// Raw returns the JSON object this value was read from, unknown fields included (nil if it was not read from JSON).\n");
            w.l("func (v *" + name + ") Raw() map[string]any { return v.raw.Map() }\n\n");
            w.l("// RawJSON returns that object's bytes as received.\n");
            w.l("func (v *" + name + ") RawJSON() json.RawMessage { return v.raw.JSON() }\n\n");
            if (result) {
                w.l(thing
                        ? "// ResponseMetadata returns the HTTP status, request id and API version of the response this " + name + " was read from:\n"
                                + "// the zero value for a list item, a snapshot entry or one built in code. It is never marshalled.\n"
                        : "// ResponseMetadata returns the HTTP status, request id and API version of the response this result was read from\n"
                                + "// (the zero value for a result built in code).\n");
                w.l("func (v *" + name + ") ResponseMetadata() core.ResponseMetadata { return v.metadata }\n\n");
            }
            if (pageCursor.isPresent()) {
                String c = pageCursor.get();
                w.l("// HasNextPage reports whether another page follows (the page has a " + c + ").\n");
                w.l("func (v *" + name + ") HasNextPage() bool { return v != nil && v." + c + " != nil && *v." + c + " != \"\" }\n\n");
                w.l("// NextPage reads the page after this one with the same input, in exactly one request: nil, nil on the last page,\n"
                        + "// with no request. Keep " + c + " for state that outlives the page: given as the input's cursor, it reads the same\n"
                        + "// next page. Cursors only go forward, so there is no previous page.\n");
                w.l("func (v *" + name + ") NextPage(ctx context.Context) (*" + name + ", error) {\n"
                        + "\tif !v.HasNextPage() || v.nextPage == nil {\n\t\treturn nil, nil\n\t}\n\treturn v.nextPage(ctx)\n}\n\n");
            }
            if (!unions.isEmpty()) {
                w.l("// EventID returns the event's SSE id: empty when the value is not an event itself, such as another event's data.\n");
                w.l("func (v *" + name + ") EventID() string { return v.eventID }\n\n");
                if (eventNames.size() == 1) {
                    w.l("// EventType returns the event's SSE event name, " + Names.str(eventNames.iterator().next()) + ".\n");
                    w.l("func (*" + name + ") EventType() string { return " + Names.str(eventNames.iterator().next()) + " }\n\n");
                } else {
                    // One structure carries several events (document.created and document.updated are both a
                    // DocumentChanged): the event name it arrived as tells them apart.
                    w.l("// EventType returns the SSE event name the event arrived as: one of " + String.join(", ", eventNames)
                            + " (empty when the value is not an event itself).\n");
                    w.l("func (v *" + name + ") EventType() string { return v.eventType }\n\n");
                }
                for (ShapeId u : unions) {
                    w.l("func (*" + name + ") is" + Names.exported(u.getName()) + "() {}\n\n");
                }
            }
        });
    }

    /** The SSE event names a structure arrives as, across the unions it is a member of. */
    static java.util.Set<String> eventNames(GoContext ctx, StructureShape shape, List<ShapeId> unions) {
        java.util.Set<String> names = new java.util.TreeSet<>();
        for (ShapeId u : unions) {
            ctx.model().expectShape(u, UnionShape.class).getAllMembers().values().stream()
                    .filter(m -> m.getTarget().equals(shape.getId())).forEach(m -> names.add(ModelFacts.wireName(m)));
        }
        return names;
    }

    /** Go's zero value is the only default the generated structs can express. */
    private static void checkDefault(MemberShape m) {
        m.getTrait(DefaultTrait.class).ifPresent(d -> {
            Node v = d.toNode();
            boolean zero = v.isNullNode()
                    || v.asStringNode().map(s -> s.getValue().isEmpty()).orElse(false)
                    || v.asBooleanNode().map(b -> !b.getValue()).orElse(false)
                    || v.asNumberNode().map(n -> n.getValue().doubleValue() == 0).orElse(false)
                    || v.asArrayNode().map(a -> a.isEmpty()).orElse(false)
                    || v.asObjectNode().map(o -> o.isEmpty()).orElse(false);
            if (!zero) {
                throw new CodegenException(m.getId() + ": a non-zero @default is not supported yet");
            }
        });
    }

    private static String doc(Shape s) {
        return s.getTrait(DocumentationTrait.class).map(DocumentationTrait::getValue).orElse("");
    }

    // ------------------------------------------------------------------ errors

    @Override
    public void generateError(GenerateErrorDirective<GoContext, GoSettings> directive) {
        StructureShape shape = directive.shape();
        GoContext ctx = directive.context();
        for (MemberShape m : shape.getAllMembers().values()) {
            if (!facts.problemFields.contains(m.getMemberName())) {
                throw new CodegenException(m.getId() + ": error members beyond the problem-details fields are not supported yet");
            }
        }
        String name = ctx.symbolProvider().toSymbol(shape).getName();
        int status = shape.getTrait(HttpErrorTrait.class).map(HttpErrorTrait::getCode)
                .orElseThrow(() -> new CodegenException(shape.getId() + " has no @httpError"));
        ctx.writerDelegator().useFileWriter("errors.go", "", w -> {
            w.imp(ctx.settings().coreModule());
            String text = doc(shape);
            w.l(Names.comment(name + " is returned for HTTP " + status + " (" + shape.getId().getName() + " in the model)."
                    + (text.isEmpty() ? "" : " " + text)
                    + " It embeds *Error, so errors.As works with either type, and its fields (Status, Code, RequestID…) read directly.", ""));
            w.l("type " + name + " struct{ *core.APIError }\n\n");
            w.l("// Unwrap returns the embedded *Error.\n");
            w.l("func (e *" + name + ") Unwrap() error { return e.APIError }\n\n");
        });
    }

    // ------------------------------------------------------------------ enums

    @Override
    public void generateEnumShape(GenerateEnumDirective<GoContext, GoSettings> directive) {
        Shape s = directive.shape();
        if (!s.isEnumShape()) {
            throw new CodegenException(s.getId() + ": string shapes with @enum are not supported; use enum");
        }
        enumShape(directive.context(), (EnumShape) s);
    }

    private void enumShape(GoContext ctx, EnumShape shape) {
        if (!done.add(shape.getId())) {
            return;
        }
        String name = Names.exported(shape.getId().getName());
        ctx.writerDelegator().useFileWriter("types.go", "", w -> {
            w.l(Names.doc(name, doc(shape), false, ""));
            w.l("//\n// " + name + " is open: a value this SDK does not know yet is kept as it is.\n");
            w.l("type " + name + " string\n\n");
            w.l("// " + name + " values known to this SDK.\nconst (\n");
            List<String> consts = new ArrayList<>();
            shape.getEnumValues().forEach((member, value) -> {
                String c = name + Names.exported(member);
                consts.add(c);
                w.l("\t" + c + " " + name + " = " + Names.str(value) + "\n");
            });
            w.l(")\n\n");
            w.l("// Known reports whether v is one of the values known to this SDK.\n");
            w.l("func (v " + name + ") Known() bool {\n\tswitch v {\n\tcase " + String.join(", ", consts)
                    + ":\n\t\treturn true\n\t}\n\treturn false\n}\n\n");
        });
    }

    @Override
    public void generateIntEnumShape(GenerateIntEnumDirective<GoContext, GoSettings> directive) {
        throw new CodegenException(directive.shape().getId() + ": intEnum is not supported yet");
    }

    // ------------------------------------------------------------------ unions

    @Override
    public void generateUnion(GenerateUnionDirective<GoContext, GoSettings> directive) {
        union(directive.context(), directive.shape());
    }

    private void union(GoContext ctx, UnionShape shape) {
        if (!done.add(shape.getId())) {
            return;
        }
        if (!facts.sseUnions.contains(shape.getId())) {
            throw new CodegenException(shape.getId() + ": unions outside @sseEvents are not supported yet");
        }
        String name = Names.exported(shape.getId().getName());
        List<MemberShape> events = List.copyOf(shape.getAllMembers().values());
        boolean watch = facts.watchUnions.contains(shape.getId());
        ctx.writerDelegator().useFileWriter("types.go", "", w -> {
            w.imp("encoding/json").imp(ctx.settings().coreModule());
            List<String> types = events.stream().map(m -> "*" + ctx.symbolProvider().toSymbol(ctx.model().expectShape(m.getTarget())).getName()).toList();
            w.l(Names.doc(name, doc(shape), false, ""));
            w.l("//\n");
            w.l(Names.comment(name + " is one of" + String.join(", ", types) + ". Switch on its type; event names this "
                    + "SDK does not know are skipped. On a stream with a final event, an error event ends the stream with a "
                    + "typed error instead; on a watch it is delivered like any other.", ""));
            w.l("//\n//\tswitch e := ev.(type) {\n//\tcase " + types.get(0) + ":\n//\t\t…\n//\t}\n");
            w.l("type " + name + " interface {\n\t// EventID returns the event's SSE id.\n\tEventID() string\n"
                    + "\t// EventType returns the event's SSE event name, for example \"text.delta\".\n\tEventType() string\n"
                    + (watch ? "\t// GetProcessing returns the watched thing's processing on a scope's watch (doc.Watch, folder.Watch,\n"
                            + "\t// batch.Watch); nil when the event carries none. Get-prefixed, as an event may have a Processing field.\n"
                            + "\tGetProcessing() *Processing\n"
                            + "\t// ProcessingOf returns, on the knowledge base's own watch, the processing of the document or job whose\n"
                            + "\t// identifier is given; nil when the event carries none.\n\tProcessingOf(id string) *Processing\n" : "")
                    + "\tis" + name + "()\n}\n\n");
            if (watch) {
                // The accessor is the hand-written processingOf (go/processing.go), for every event alike.
                for (MemberShape m : events) {
                    String t = ctx.symbolProvider().toSymbol(ctx.model().expectShape(m.getTarget())).getName();
                    if (processingDone.add(t)) {
                        w.l("// GetProcessing returns the watched thing's processing, or nil (" + name + ".GetProcessing).\n");
                        w.l("func (v *" + t + ") GetProcessing() *Processing { return processingOf(v, \"\") }\n\n");
                        w.l("// ProcessingOf returns the processing of the document or job named by id, or nil (" + name + ".ProcessingOf).\n");
                        w.l("func (v *" + t + ") ProcessingOf(id string) *Processing { return processingOf(v, id) }\n\n");
                    }
                }
            }
            w.l("// decode" + name + " decodes one SSE event; ok is false for an event name this SDK does not know. With raise,\n"
                    + "// an error event is returned as its typed error (a stream with a final event, PROTOCOL.md 5.5).\n");
            w.l("func decode" + name + "(errorFor core.ErrorFor, raise bool) func(name, id string, data []byte) (" + name + ", bool, error) {\n");
            w.l("\treturn func(name, id string, data []byte) (" + name + ", bool, error) {\n\t\tswitch name {\n");
            for (MemberShape m : shape.getAllMembers().values()) {
                w.l("\t\tcase " + Names.str(ModelFacts.wireName(m)) + ":\n");
                if (facts.sseErrorTargets.contains(m.getTarget())) {
                    w.l("\t\t\tif raise {\n\t\t\t\treturn nil, false, core.ProblemFromEvent(data, errorFor)\n\t\t\t}\n");
                }
                String t = ctx.symbolProvider().toSymbol(ctx.model().expectShape(m.getTarget())).getName();
                boolean shared = eventNames(ctx, ctx.model().expectShape(m.getTarget(), StructureShape.class),
                        facts.sseMemberOf.getOrDefault(m.getTarget(), List.of())).size() > 1;
                w.l("\t\t\tv := &" + t + "{eventID: id" + (shared ? ", eventType: name" : "") + "}\n\t\t\tif err := json.Unmarshal(data, v); err != nil {\n"
                        + "\t\t\t\treturn nil, false, err\n\t\t\t}\n\t\t\treturn v, true, nil\n");
            }
            w.l("\t\t}\n\t\treturn nil, false, nil\n\t}\n}\n\n");
        });
    }
}
