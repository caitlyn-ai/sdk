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
        whatsNext: z.array(z.object({ link: z.string(), title: z.string(), description: z.string(), section: z.string(), icon: z.string() })).optional(),
        whatsNextNotes: z.array(z.string()).optional(),
        // An SDK reference operation's header strip (src/components/OperationHeader.astro)
        operation: z
          .object({ name: z.string(), method: z.string(), calls: z.record(z.string(), z.string()), http: z.object({ method: z.string(), path: z.string() }),
            api: z.string(),
            // Each example's code per language, its response status and body, and a stream's sample events, for the code
            // panel (src/components/OperationPanel.astro)
            panel: z.array(z.object({ title: z.string(), code: z.record(z.string(), z.string()), status: z.number(), result: z.string().nullable(), events: z.string().nullable() })),
          })
          .optional(),
      }),
    }),
  }),
};
