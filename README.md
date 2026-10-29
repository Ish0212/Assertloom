# Assertloom

Assertloom is an open-source CLI that reads a JavaScript or TypeScript file, generates Jest unit tests for it, runs them, repairs the ones that fail, and reports coverage. It doesn't assume generated tests are correct. Every test is run before it is kept.

> **Status: Week 3, AI test generation.** `analyze` statically extracts functions and dependencies, and `generate` writes Jest tests for pure functions to a preview file. Running, repairing, and mocking are not built yet.

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

## Generating tests

`generate` needs an OpenAI API key in the `OPENAI_API_KEY` environment variable.

```powershell
# PowerShell (current session)
$env:OPENAI_API_KEY = "sk-..."
```

```bash
# bash/zsh
export OPENAI_API_KEY=sk-...
```

```bash
npx tsx src/cli/index.ts generate examples/strings.ts
npx tsx src/cli/index.ts generate examples/math.ts --dry-run       # print instead of writing
npx tsx src/cli/index.ts generate examples/math.ts --model gpt-5.4  # pick a model
```

The default model is `gpt-5.4-mini`. Override it with `--model` or `ASSERTLOOM_MODEL`.

How it works:

1. The analyzer picks exported functions that don't need mocks. Functions that use external packages, local modules, or side-effecting built-ins such as `fs` are skipped and listed (mocking arrives in Week 6).
2. The model receives the source file, the function signatures, and the exact names to call them by. It returns structured test cases (name, category, body) validated with Zod, not a whole file.
3. Each case is checked before it is kept: it must parse, call `expect()`, and must not use `import`, `require`, `jest.mock`, `process` methods, or its own `describe`/`it`. Rejected cases are listed with the reason.
4. Assertloom writes the imports and `describe`/`it` blocks itself, parses the finished file, and saves it as `<name>.test.preview.<ext>` next to the source. Jest's default pattern ignores that name, because the tests have not been run yet.

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
| `assertloom generate <file> [--model] [--out] [--dry-run] [--force]` | Generate Jest tests for pure exported functions into a preview file |
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
  ai/          LLM provider interface, OpenAI provider, prompts, secret redaction
  generator/   Import planning, response schema, case validation, test file writing
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
- Only the target file is sent to the AI provider. `.env` files and other files are never sent, likely secrets (API keys, tokens, private keys, credentials in URLs, quoted `password`/`secret`/`token` values) are redacted first, and OpenAI requests are made with `store: false`.
- Files that Assertloom did not generate are never overwritten without `--force`.
- The repair loop only edits generated tests, never production source code.
- Retries, model spend, and execution time have hard limits.

Until sandboxing is in place, only run Assertloom against code you trust.

## Roadmap

1. CLI foundation (done)
2. AST code analyzer (done)
3. AI test generation (built; tested with a fake provider, live model run pending)
4. Execution engine
5. Self-repair engine
6. Dependency mocking
7. Evaluation and hardening
8. Open-source release

## License

MIT
