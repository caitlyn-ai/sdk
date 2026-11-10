package ai.caitlyn.codegen.model;

import java.util.TreeSet;
import software.amazon.smithy.codegen.core.CodegenException;
import software.amazon.smithy.model.Model;
import software.amazon.smithy.model.knowledge.OperationIndex;
import software.amazon.smithy.model.knowledge.TopDownIndex;
import software.amazon.smithy.model.shapes.OperationShape;
import software.amazon.smithy.model.shapes.ServiceShape;

/** Caitlyn release numbers (major.minor.patch) as @since carries them. */
public final class Versions {
    private Versions() {}

    public static int compare(String a, String b) {
        String[] x = a.split("\\.");
        String[] y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int xi = i < x.length ? parse(x[i], a) : 0;
            int yi = i < y.length ? parse(y[i], b) : 0;
            if (xi != yi) {
                return Integer.compare(xi, yi);
            }
        }
        return 0;
    }

    private static int parse(String part, String version) {
        try {
            return Integer.parseInt(part);
        } catch (NumberFormatException e) {
            throw new CodegenException("@since(\"" + version + "\") is not a release number. Generators read the prepared model "
                    + "(scripts/prepare-model.mjs), which stamps @since(\"next\").");
        }
    }

    /**
     * The model version an SDK is generated from (PROTOCOL.md 3.1, {@code Caitlyn-Sdk-Model}): the highest
     * @since on the service's operations and their input members, or 0.0.0 when there is none.
     */
    public static String modelVersion(Model model, ServiceShape service) {
        TreeSet<String> versions = new TreeSet<>(Versions::compare);
        OperationIndex ops = OperationIndex.of(model);
        for (OperationShape op : TopDownIndex.of(model).getContainedOperations(service)) {
            CaitlynTraits.since(op).ifPresent(versions::add);
            ops.getInputShape(op).ifPresent(in ->
                    in.getAllMembers().values().forEach(m -> CaitlynTraits.since(m).ifPresent(versions::add)));
        }
        return versions.isEmpty() ? "0.0.0" : versions.last();
    }
}
