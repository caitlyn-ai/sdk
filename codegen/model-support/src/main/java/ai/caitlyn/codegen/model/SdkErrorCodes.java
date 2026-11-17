package ai.caitlyn.codegen.model;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The codes the SDKs raise themselves (status 0, nothing received from Caitlyn: PROTOCOL.md 6.3), which the model
 * cannot list. Each generator adds them to its ErrorCode constants beside the model's @errorCodes, so callers have one
 * place to look.
 *
 * <p>Every failure during an SDK call reaches the caller as a Caitlyn error with a code, the native error kept as its
 * cause, in every runtime. So each code here is raised by every runtime ({@link #EVERY}), unless the case cannot
 * happen in one, which {@code cannot happen in <runtime>: <why>} records. Only programmer misuse that one language's
 * types or argument checks catch, or a case only one platform has, is runtime-specific, as {@code only <runtimes>:
 * <reason>}. scripts/check-error-codes.mjs scans the four runtimes and fails when one raises a code with no constant,
 * a runtime-specific code outside its runtimes, or when a runtime does not raise an every-runtime code.
 */
public final class SdkErrorCodes {
    private SdkErrorCodes() {}

    /** A code every runtime raises. */
    public static final String EVERY = "every runtime";

    /** Each code, with what it means, in the words the constants' docs use. */
    public static final Map<String, String> CODES;

    /** Each code's reach: {@link #EVERY}, or "only &lt;runtimes&gt;: &lt;reason&gt;". */
    public static final Map<String, String> RUNTIMES;

    /** For an every-runtime code, the runtimes where its case cannot happen, as "cannot happen in &lt;runtime&gt;: &lt;why&gt;". */
    public static final Map<String, List<String>> EXCEPTIONS;

    private static final Map<String, String> codes = new TreeMap<>();
    private static final Map<String, String> runtimes = new TreeMap<>();
    private static final Map<String, List<String>> exceptions = new TreeMap<>();

    private static void put(String code, String meaning, String reach, String... cannotHappen) {
        codes.put(code, meaning);
        runtimes.put(code, reach);
        if (cannotHappen.length > 0) exceptions.put(code, List.of(cannotHappen));
    }

    static {
        put("CANCELLED", "The work a wait followed was cancelled, or a sync's plan was declined.", EVERY);
        put("CONNECTION_ERROR", "No response arrived from Caitlyn, after the SDK's retries.", EVERY);
        put("DECODE_FAILED", "A response or event could not be decoded as the operation's output.", EVERY);
        put("FILE_CHANGED", "A file's size or bytes no longer match what was described for it.", EVERY);
        put("FILE_TOO_LARGE", "A file is larger than the operation accepts.", EVERY);
        put("FILE_UNREADABLE", "A file could not be read.", EVERY);
        put("HTTP_CLIENT_FAILED", "The HTTP client could not be built, or could not make the request.", EVERY,
            "cannot happen in typescript: it sends with fetch, so there is no HTTP client to build, and a fetch that fails is CONNECTION_ERROR");
        put("INGESTION_BATCH_FAILED", "An ingestion batch ended failed without a failure code of its own.", EVERY);
        put("INGESTION_BATCH_NOT_PLANNED", "The upload estimate was asked for on a draft batch.", EVERY);
        put("INGESTION_BATCH_NOT_STARTED", "Files were uploaded to a batch that has not started.", EVERY);
        put("INGESTION_ITEM_HAS_NO_FILE", "A sync's batch awaits a file this call has none for.", EVERY);
        put("INGESTION_ITEM_REFUSED", "An item a sync added to its batch was refused.", EVERY);
        put("JOB_FAILED", "A job ended failed without an error code of its own.", EVERY);
        put("NO_FINAL_EVENT", "A stream ended without its final event.", EVERY);
        put("SERIALIZATION_FAILED", "A request could not be serialised.", EVERY);
        put("STREAM_LOST", "A stream or watch dropped and could not be resumed.", EVERY);
        put("UPLOAD_FAILED", "A file's upload still failed after its retries; only its item fails.", EVERY);
        put("UPLOAD_POLICY_MISSING", "A batch gave no upload policy for the files awaiting upload.", EVERY);
        put("UPLOAD_PUT_FAILED", "A file's bytes could not be sent to its upload address.", EVERY);
        put("WAIT_TIMEOUT", "A wait's time limit passed.", EVERY);
        put("BAD_METHOD", "An operation's HTTP method could not be used.",
            "only rust: the generated method name is parsed into reqwest's Method type, a check the other SDKs have no step for");
        put("FILE_ALREADY_READ", "A stream given as a file was already read by an earlier call.",
            "only go: giving one io.Reader to two calls is misuse that Go's UploadFile alone records; elsewhere the second read fails as FILE_UNREADABLE or reads nothing");
        put("REDIRECT_UNREADABLE", "A browser hid a redirect's address from the page.",
            "only typescript: only a browser page is refused a redirect's address");
        CODES = Collections.unmodifiableMap(codes);
        RUNTIMES = Collections.unmodifiableMap(runtimes);
        EXCEPTIONS = Collections.unmodifiableMap(exceptions);
    }
}
