import { z } from 'zod';

/**
 * Typed domain model for a campaign product's `attributes` JSONB (T9b/O7).
 * The legacy demo carried `flavors`/`shapes`/`weight`; new identity fields
 * live in the Variant/Identifier tables (ADR-0001). The Zod schema parses at
 * read time so consumers stop hand-rolling `asStringArray(attributes.shapes)`
 * guesses; unknown keys stay allowed so the column remains extensible.
 */
export const productAttributesSchema = z
  .object({
    weight: z.string().optional(),
    // `.catch([])` keeps the parse tolerant of legacy malformed values
    // (e.g. a single string where an array was expected) so reads never crash
    // on historical rows — mirroring the old asStringArray fallback.
    flavors: z.array(z.string()).catch([]).optional(),
    shapes: z.array(z.string()).catch([]).optional(),
  })
  .catchall(z.unknown());

export type ProductAttributes = z.infer<typeof productAttributesSchema>;

/**
 * Typed domain model for a campaign lot's `attributes` JSONB. Currently
 * unshaped (seeds write `{}`); kept as a documented empty-object schema so a
 * future lot-scoped field has a typed home without re-touching consumers.
 */
export const lotAttributesSchema = z.object({}).catchall(z.unknown());

export type LotAttributes = z.infer<typeof lotAttributesSchema>;

/** Runtime parse of a stored product-attributes value (safe when unknown). */
export function parseProductAttributes(value: unknown): ProductAttributes {
  return productAttributesSchema.parse(value ?? {});
}

/** Runtime parse of a stored lot-attributes value. */
export function parseLotAttributes(value: unknown): LotAttributes {
  return lotAttributesSchema.parse(value ?? {});
}
