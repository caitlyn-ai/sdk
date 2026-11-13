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
      }),
    }),
  }),
};
