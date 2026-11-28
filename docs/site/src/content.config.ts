// The pages are Starlight docs. Besides Starlight's fields, each page carries the developer-docs knowledge
// base's fields (docs/README.md, scripts/docs-metadata.mjs), which scripts/docs-build.mjs has already checked.
import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        pageType: z.string().optional(),
        sinceVersion: z.number().optional(),
        resources: z.array(z.string()).optional(),
        integrations: z.array(z.string()).optional(),
        operations: z.array(z.string()).optional(),
        // The site's "What's next" for the page (src/whats-next.json, resolved by scripts/docs-build.mjs)
        // Where the page sits, shown above its title (src/components/PageTitle.astro)
        section: z.string().optional(),
        // An operation's or SDK helper's name, under its title (the title is the job: "Add a document")
        subtitle: z.string().optional(),
        // A page's release-channel note beside its title (an operation the betas dropped: "Removed in 0.12.0-beta.1")
        channel: z.object({ text: z.string(), link: z.string(), title: z.string() }).optional(),
        whatsNext: z.array(z.object({ link: z.string(), title: z.string(), description: z.string(), section: z.string(), icon: z.string() })).optional(),
        whatsNextNotes: z.array(z.string()).optional(),
        // The API reference's overview: its Workspace box, and the old addresses of its operations (#tag/...) to send on
        server: z.boolean().optional(),
        apiAnchors: z.record(z.string(), z.string()).optional(),
        // An operation's header strip (src/components/OperationHeader.astro), in the SDK reference or the API reference
        operation: z
          .object({ kind: z.enum(['sdk', 'api']).optional(), name: z.string(), stability: z.string().optional(),
            // The release channel: the Beta label beside the stability badge, for an operation no stable release has
            channel: z.object({ text: z.string(), link: z.string(), title: z.string() }).optional(),
            method: z.string(), calls: z.record(z.string(), z.string()), http: z.object({ method: z.string(), path: z.string() }),
            // The same operation in the other reference
            other: z.object({ label: z.string(), link: z.string() }),
            // Each example's code per language, its response status and body (or, in the API reference, the HTTP
            // response), and a stream's sample events, for the code panel (src/components/OperationPanel.astro)
            panel: z.array(z.object({ title: z.string(), code: z.record(z.string(), z.string()), status: z.number(), result: z.string().nullable(), response: z.string().nullable().optional(), events: z.string().nullable() })),
            // Every status the operation documents, with its body: an example's, or the problem details every error has
            // (sample, with the status's first code)
            // What the call returns in each SDK language (HTML, its types linked), and the error class each raises by
            // status (scripts/docs-api.mjs sdkReturns)
            returns: z.record(z.string(), z.string()).optional(),
            errorClasses: z.record(z.string(), z.record(z.string(), z.string())).optional(),
            responses: z.array(z.object({ status: z.number(), result: z.string().nullable().optional(), response: z.string().nullable().optional(), events: z.string().nullable(), sample: z.boolean(), code: z.string().optional() })).optional(),
          })
          .optional(),
      }),
    }),
  }),
};
