import { z } from 'zod';

export const columnMappingSchema = z.record(z.string().trim().min(1));
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const updateImportMappingSchema = z.object({
  column_mapping: columnMappingSchema,
});
export type UpdateImportMappingInput = z.infer<typeof updateImportMappingSchema>;
