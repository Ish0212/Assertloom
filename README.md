# Assertloom

Assertloom is an open-source CLI that reads a JavaScript or TypeScript file, generates Jest unit tests for it, runs them, repairs the ones that fail, and reports coverage. It doesn't assume generated tests are correct. Every test is run before it is kept.

> **Status: Week 2, AST analyzer.** `analyze` statically extracts functions, parameters, types, imports, and dependencies. Test generation, execution, and repair are not built yet.

## Requirements

- Node.js 22 or newer

## Run from source

```bash
git clone <repo-url> assertloom
cd assertloom
npm install

npx tsx src/cli/index.ts analyze examples/math.ts
# or
npm run dev -- analyze examples/math.ts
```

Example output:

```
✓ Parsed examples/math.ts (TypeScript, ESM)
✓ Found 2 exported functions
✓ Found 0 dependencies (0 external, 0 local, 0 built-in)

  add(a: number, b: number): number
  divide(a: number, b: number): number  [throws]
```

Add `--json` for the full analysis object. Each function includes its export names, kind (declaration, arrow, or expression), async/generator flags, parameters (name, type, optional, rest, default value), return type, type parameters, whether it throws directly, and the imported modules it uses.

## What the analyzer understands

- ESM and CommonJS: `export function`, `export const fn = () => {}`, `export { a as b }`, `export default`, `module.exports = { ... }`, `module.exports = fn`, and `exports.x = fn`
- TypeScript: parameter and return types, generics, overloads (only the implementation is kept), `declare` (skipped), and `satisfies`/`as` wrappers
- Imports: `import`, type-only imports (excluded from runtime dependencies), re-exports, `require()`, and dynamic `import()`, each classified as local, external package, or Node built-in
- Per-function dependencies, including top-level values built from imports (for example `const prisma = new PrismaClient()`), while ignoring parameters that shadow an import

Classes and object methods outside `module.exports` are not analyzed yet.

## Build and link locally

```bash
npm run build
npm link
assertloom --help
```

## Commands

| Command | Description |
| --- | --- |
| `assertloom analyze <file> [--json]` | Statically analyze functions, parameters, imports, and dependencies |
| `assertloom generate <file>` | Validate a source file (test generation not implemented yet) |
| `assertloom help [command]` | Show help |

Supported extensions: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`. Missing files, directories, unsupported extensions, existing `*.test.*`/`*.spec.*` files, and files over 1 MB are rejected with exit code 1.

## Development

```bash
npm test          # Vitest
npm run typecheck
npm run build     # outputs to dist/
```

## Project layout

```
src/
  cli/         Commander entry point, commands, input validation
  analyzer/    Babel AST analysis: parser, functions, dependencies
  ai/          LLM provider interface and prompts (Week 3)
  generator/   Test generation and writing (Week 3)
  runner/      Jest execution and coverage (Week 4)
  repair/      Failure classification and repair loop (Week 5)
  types/       Shared types
examples/      Sample source files
fixtures/      Inputs for Assertloom's own tests
tests/         Assertloom's own tests (Vitest)
```

## Security principles

Assertloom treats target repositories and generated tests as untrusted:

- Analysis is static. Target code is never executed during analysis.
- Generated tests will run in a resource-limited environment with network access off by default.
- `.env` files, secrets, and unrelated files are never sent to an AI provider.
- Existing tests are never overwritten without showing a diff.
- The repair loop only edits generated tests, never production source code.
- Retries, model spend, and execution time have hard limits.

Until sandboxing is in place, only run Assertloom against code you trust.

## Roadmap

1. CLI foundation (done)
2. AST code analyzer (done)
3. AI test generation
4. Execution engine
5. Self-repair engine
6. Dependency mocking
7. Evaluation and hardening
8. Open-source release

## License

MIT
