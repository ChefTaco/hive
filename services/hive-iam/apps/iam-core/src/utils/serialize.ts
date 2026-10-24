/**
 * Utility helpers for deserialising JSON-string fields returned by
 * Prisma when using SQLite (which stores Json schema-type values as
 * plain TEXT).
 *
 * Call `parseJsonFields` on any Prisma result object before returning
 * it in a JSON response so the client receives proper arrays/objects
 * instead of escaped JSON strings.
 */

/**
 * Parse specified fields from JSON strings into their JS values.
 * Fields that are already arrays/objects (or null/undefined) are left
 * untouched.
 */
export function parseJsonFields<T extends Record<string, unknown>>(
  obj: T,
  ...fields: (keyof T)[]
): T {
  const clone = { ...obj }
  for (const field of fields) {
    const val = clone[field]
    if (typeof val === 'string') {
      try {
        ;(clone as Record<string, unknown>)[field as string] = JSON.parse(val)
      } catch {
        // leave as-is if it's not valid JSON
      }
    }
  }
  return clone
}

/**
 * Parse JSON fields on every element of an array.
 */
export function parseJsonFieldsArray<T extends Record<string, unknown>>(
  arr: T[],
  ...fields: (keyof T)[]
): T[] {
  return arr.map((item) => parseJsonFields(item, ...fields))
}
