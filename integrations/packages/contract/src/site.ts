import { z } from 'zod';
import { SlugSchema } from './manifest';

export const CatalogEntrySchema = z.object({
  id: SlugSchema,
  number: z.number().int().min(0),
  title: z.string().min(1),
  tagline: z.string().min(1),
  integrations: z.array(z.string().min(1)),
  hasReplay: z.boolean(),
});

export const CatalogSchema = z.array(CatalogEntrySchema);

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
