/**
 * Specwatch CLI entry point.
 *
 * Zero-infrastructure developer tool that learns API schemas
 * from live traffic and generates OpenAPI specs.
 *
 * Usage:
 *   npx specwatch start https://api.example.com
 *   specwatch status
 *   specwatch export
 */

import { createProgram } from './cli/commands.js';

const program = createProgram();
program.parseAsync(process.argv).catch(() => {
  process.exit(1);
});
