/**
 * OpenAPI operation mapping helpers for agent evidence export.
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export interface OpenApiOperationRef {
  method: string;
  path: string;
  operationId?: string;
  specLocation: string;
}

export interface OperationMatch {
  operation?: OpenApiOperationRef;
  warning?: string;
}

export function loadOpenApiSpec(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenAPI spec at ${filePath} did not parse to an object`);
  }
  return parsed as Record<string, unknown>;
}

export function collectOpenApiOperations(spec: Record<string, unknown>): OpenApiOperationRef[] {
  const paths = spec['paths'];
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return [];

  const operations: OpenApiOperationRef[] = [];
  for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) continue;

    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      const lowerMethod = method.toLowerCase();
      if (!HTTP_METHODS.has(lowerMethod)) continue;
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;

      const operationRecord = operation as Record<string, unknown>;
      const operationId =
        typeof operationRecord['operationId'] === 'string'
          ? operationRecord['operationId']
          : undefined;

      operations.push({
        method: lowerMethod.toUpperCase(),
        path,
        operationId,
        specLocation: `#/paths/${escapePointer(path)}/${lowerMethod}`,
      });
    }
  }

  return operations;
}

export function matchOpenApiOperation(
  operations: OpenApiOperationRef[],
  method: string,
  observedPath: string,
): OperationMatch {
  const normalizedMethod = method.toUpperCase();
  const methodMatches = operations.filter((op) => op.method === normalizedMethod);

  const exact = methodMatches.filter((op) => op.path === observedPath);
  if (exact.length === 1) return { operation: exact[0] };
  if (exact.length > 1) {
    return {
      warning: `Ambiguous OpenAPI match for ${normalizedMethod} ${observedPath}: ${exact.map((op) => op.path).join(', ')}`,
    };
  }

  const templated = methodMatches.filter((op) => pathTemplatesCompatible(op.path, observedPath));
  if (templated.length === 1) return { operation: templated[0] };
  if (templated.length > 1) {
    return {
      warning: `Ambiguous OpenAPI template match for ${normalizedMethod} ${observedPath}: ${templated.map((op) => op.path).join(', ')}`,
    };
  }

  return { warning: `No OpenAPI operation matched ${normalizedMethod} ${observedPath}` };
}

export function parseOperationKey(operationKey: string): { method: string; path: string } | undefined {
  const match = operationKey.match(/^([A-Z]+)\s+(.+)$/);
  if (!match) return undefined;
  return { method: match[1], path: match[2] };
}

function pathTemplatesCompatible(specPath: string, observedPath: string): boolean {
  const specSegments = splitPath(specPath);
  const observedSegments = splitPath(observedPath);
  if (specSegments.length !== observedSegments.length) return false;

  return specSegments.every((specSegment, index) => {
    const observedSegment = observedSegments[index];
    return specSegment === observedSegment || isTemplateSegment(specSegment) || isTemplateSegment(observedSegment);
  });
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function isTemplateSegment(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
