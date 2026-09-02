import { z } from "zod";

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 1000;
export const MAX_FILE_PATH_LENGTH = 4096;

export const fileRevisionSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), modifiedAt: z.number(), size: z.number().int().nonnegative() }).strict();
export const fileEntrySchema = z.object({ name: z.string().min(1), kind: z.enum(["file", "directory"]), path: z.string(), revision: fileRevisionSchema.nullable() }).strict();
export const fileListingSchema = z.object({ path: z.string(), entries: z.array(fileEntrySchema).max(MAX_DIRECTORY_ENTRIES), nextCursor: z.string().nullable() }).strict();
export const fileReadSchema = z.object({ path: z.string(), content: z.string(), revision: fileRevisionSchema }).strict();
export const fileWriteSchema = z.object({ path: z.string(), revision: fileRevisionSchema }).strict();
export type FileRevision = z.infer<typeof fileRevisionSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type FileListing = z.infer<typeof fileListingSchema>;
export type FileRead = z.infer<typeof fileReadSchema>;
export type FileWrite = z.infer<typeof fileWriteSchema>;
