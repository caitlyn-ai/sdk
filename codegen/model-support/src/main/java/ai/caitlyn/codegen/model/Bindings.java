package ai.caitlyn.codegen.model;

import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.HttpBinding;
import software.amazon.smithy.model.knowledge.HttpBindingIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;

/** HTTP binding checks shared by the generators. */
public final class Bindings {
    private Bindings() {}

    /** Fails early, naming the operation, on bindings no generator supports yet. */
    public static void checkSupported(Model model, ServiceShape service) {
        HttpBindingIndex http = HttpBindingIndex.of(model);
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            for (HttpBinding b : http.getRequestBindings(op).values()) {
                if (b.getLocation() == HttpBinding.Location.PREFIX_HEADERS || b.getLocation() == HttpBinding.Location.QUERY_PARAMS) {
                    throw new CodegenException(op.getId() + ": @" + b.getLocation() + " bindings are not supported yet");
                }
            }
        }
    }
}
