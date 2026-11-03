/**
 * Project traffic-derived learning data into a conservative validation contract.
 * This is deliberately separate from low-level schema conversion, where callers
 * may supply explicit enum constraints that must continue to be preserved.
 */
import type { AggregatedSchema, InferredSchema } from '../types/index.js';

export function prepareLearnedSchemasForExport(
  schemas: AggregatedSchema[],
  includeInferredEnums = false,
): AggregatedSchema[] {
  function project(schema: InferredSchema): InferredSchema {
    const result = { ...schema };
    if (!includeInferredEnums) delete result.enum;
    if (schema.properties !== undefined) {
      result.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([name, child]) => [name, project(child)]),
      );
    }
    if (schema.items !== undefined) result.items = project(schema.items);
    if (schema.oneOf !== undefined) result.oneOf = schema.oneOf.map(project);
    return result;
  }

  return schemas.map((schema) => ({
    ...schema,
    ...(schema.requestSchema !== undefined ? { requestSchema: project(schema.requestSchema) } : {}),
    ...(schema.responseSchemas !== undefined
      ? {
          responseSchemas: Object.fromEntries(
            Object.entries(schema.responseSchemas).map(([status, body]) => [
              status,
              body === null ? null : project(body),
            ]),
          ),
        }
      : {}),
  }));
}
