import { z } from 'zod';
import { SlugSchema } from './manifest';

export const MediaGroupSchema = z.enum(['console', 'replay']);

export const MediaVideoSchema = z.object({
  src: z.string().min(1),
  title: z.string().min(1),
});

export const MediaScreenshotSchema = z.object({
  src: z.string().min(1),
  caption: z.string().min(1),
  group: MediaGroupSchema,
});

export const CatalogMediaSchema = z.object({
  videos: z.array(MediaVideoSchema),
  screenshots: z.array(MediaScreenshotSchema),
});

export const CatalogEntrySchema = z.object({
  id: SlugSchema,
  number: z.number().int().min(0),
  title: z.string().min(1),
  tagline: z.string().min(1),
  integrations: z.array(z.string().min(1)),
  hasReplay: z.boolean(),
  media: CatalogMediaSchema.optional(),
});

export const CatalogSchema = z.array(CatalogEntrySchema);

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type CatalogMedia = z.infer<typeof CatalogMediaSchema>;
export type MediaVideo = z.infer<typeof MediaVideoSchema>;
export type MediaScreenshot = z.infer<typeof MediaScreenshotSchema>;
export type MediaGroup = z.infer<typeof MediaGroupSchema>;
