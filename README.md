# Assertloom

Assertloom is an open-source CLI that reads a JavaScript or TypeScript file, generates Jest unit tests for it, runs them, repairs the ones that fail, and reports coverage. It doesn't assume generated tests are correct. Every test is run before it is kept.

![Terminal recording: npx assertloom generate src/rates.js mocks fetch, generates 8 tests, runs them with the network blocked, and saves them with 100% coverage](docs/demo.svg)

<sub>A real session on [`examples/sample-project`](examples/sample-project/README.md), recorded with `scripts/record-demo.mjs` (pauses for the model shortened to 2 seconds). The raw recording is in `docs/demo.cast` and plays with `asciinema play docs/demo.cast`.</sub>

> **Status: 0.1.0, first public release.** `analyze` statically extracts functions, dependencies, and how each import is used. `generate` writes Jest tests for every exported function, mocks the dependencies that do I/O (packages, databases, the file system, `fetch`), runs the tests with network access blocked, and repairs failing tests in up to three rounds within a spending limit. `run` reports pass/fail counts and coverage for any test file. On 9 files from 9 open-source packages, 98.7% of the kept tests pass and mean line coverage goes from 0% to 95%, for $0.07 in total ([benchmark](#benchmark)).

## Install

Assertloom needs Node.js 22 or newer and, for `generate`, an [OpenAI API key](https://platform.openai.com/api-keys).

```bash
npm install --save-dev assertloom
export OPENAI_API_KEY=sk-...          # PowerShell: $env:OPENAI_API_KEY = "sk-..."

npx assertloom generate src/utils.ts
```

You can also run it without installing: `npx assertloom@latest generate src/utils.ts`. Your project doesn't need Jest; Assertloom brings its own and uses your Jest and config if you have them.

To see it work on a prepared project first, follow [`examples/sample-project`](examples/sample-project/README.md). It walks through pure logic, an HTTP client with `fetch`, and file system code.

## Run from source

```bash
git clone https://github.com/Ish0212/Assertloom.git
cd Assertloom
npm install

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

- ESM and CommonJS: `export function`, `export const fn = () => {}`, `export { a as b }`, `export default`, `module.exports = { ... }`, `module.exports = fn`, `exports.x = fn`, and an object declared first and exported later (`const api = { parse }; module.exports = api`, `exports.parse = api.parse`)
- TypeScript: parameter and return types, generics, overloads (only the implementation is kept), `declare` (skipped), and `satisfies`/`as` wrappers
- Imports: `import`, type-only imports (excluded from runtime dependencies), re-exports, `require()`, and dynamic `import()`, each classified as local, external package, or Node built-in
- Per-function dependencies, including top-level values built from imports (for example `const prisma = new PrismaClient()`), while ignoring parameters that shadow an import
- How each imported value is used: called, constructed with `new`, used with `instanceof`, which members are accessed, and whether a call's result is kept (and whether that happens when the module loads). Mocks are built from this.
- Uses of the global `fetch` (unless the code declares its own `fetch`)

Classes, object methods outside `module.exports`, and UMD wrappers (`(function (root, factory) { ... })(this, function () { ... })`) are not analyzed yet.

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
npx assertloom generate examples/strings.ts
npx assertloom generate examples/math.ts --dry-run        # print instead of writing
npx assertloom generate examples/math.ts --model gpt-5.4  # pick a model
```

From a source checkout, use `npm run dev -- generate ...` instead of `npx assertloom generate ...`.

The default model is `gpt-5.4-mini`. Override it with `--model` or `ASSERTLOOM_MODEL`.

`examples/strings.test.ts`, `examples/math.test.ts`, and `examples/users.test.ts` are unedited output from `gpt-5.4-mini`. For `strings.ts`, 24 of 26 generated tests passed on the first run, and one repair round fixed the other 2, ending at 26/26 passing with 100% coverage. `users.ts` depends on two external packages (`axios` and `pg`); see [Mocking dependencies](#mocking-dependencies).

How it works:

1. The analyzer finds the exported functions and every dependency they use.
2. Assertloom decides which dependencies to mock and writes the mocks itself (see below).
3. The model receives the source file, the function signatures, the exact names to call them by, and a description of the mocks. It returns structured test cases (name, category, body) validated with Zod, not a whole file.
4. Each case is checked before it is kept: it must parse, call `expect()`, and must not use `import`, `require`, `jest.mock`, `jest.requireActual` and similar module-loading calls, `process` methods that affect the test run (`exit`, `chdir`, ...), `module.exports`, or its own `describe`/`it`. It also must not stub or spy on the functions under test: calls inside the source file bypass spies, so only dependencies can be controlled. Rejected cases are listed with the reason.
5. Assertloom writes the mocks, imports, and `describe`/`it` blocks itself, parses the finished file, and saves it as `<name>.test.preview.<ext>` next to the source. Jest's default pattern ignores that name, because the tests have not been run yet.
6. Assertloom runs the preview with Jest. If every test passes, it is saved as `<name>.test.<ext>` and the preview is deleted. If any fail, Assertloom tries to repair them (see below), and keeps the preview for review if failures remain. Use `--no-run` to skip running and repairing.

If the destination test file already exists, Assertloom prints a unified diff of the changes before overwriting it. Files it did not generate are never overwritten without `--force`.

Each command prints its token usage and estimated cost (`Tokens: 2,431 in / 1,020 out, ≈$0.0064`), and `--report` includes the cost. Before every model call, Assertloom checks the worst case (the full prompt plus the maximum output) against `--max-cost` (default $1) and stops instead of going over. Models without a known price are capped at 500,000 tokens.

## Mocking dependencies

Assertloom writes every `jest.mock()` call itself, based on how the source uses each import. The model never writes mocks; it only sets return values inside each test (`mockResolvedValue`, `mockRejectedValue`, and so on). Mocked modules are never loaded, so tests don't touch real databases, APIs, or files, and the packages don't even need to be installed.

`examples/users.ts` loads users from Postgres through `pg` and falls back to an HTTP API through `axios`:

```
✓ Analyzed 3 exported functions (3 tested)
✓ Mocked 2 dependencies: axios, pg
  - axios: external package, not installed (virtual mock)
  - pg: external package, not installed (virtual mock)
✓ Generated 9 test cases (5 normal, 2 edge, 2 error)
✓ Ran Jest: 9 passed, 0 failed (bundled Jest, Assertloom default config, network blocked, 2.9s)
✓ Coverage: 100% lines, 100% branches, 100% functions
```

The generated file starts with mocks shaped like the code that uses them:

```ts
jest.mock("axios", () => ({ __esModule: true, default: { get: jest.fn(), isAxiosError: jest.fn() } }), { virtual: true });
jest.mock("pg", () => {
  const instance1 = { query: jest.fn() };
  return { __esModule: true, Pool: function () { return instance1; } };
}, { virtual: true });

import axios from "axios";
import { Pool } from "pg";
import { getUser, importUser, countUsersByDomain } from "./users";

const pool = new Pool();

beforeEach(() => {
  jest.resetAllMocks();
});
```

What gets mocked:

| Dependency | Default |
| --- | --- |
| External packages | Mocked, except utility libraries without I/O (`zod`, `lodash`, `date-fns`, and similar), which stay real |
| Node built-ins | `fs`, `child_process`, `http`, and other built-ins with side effects are mocked; `path`, `url`, `util`, and similar stay real |
| Local modules | Assertloom reads them (without running them). A module is mocked if it, or anything it imports, does I/O; otherwise the real code runs |
| Global `fetch` | Replaced with a `jest.fn()` for the test file and restored afterwards |

Override the defaults with `--mock <module>` and `--keep-real <module>` (both repeatable), using the specifier as written in the source or the package name.

How mocks are shaped:

- Functions become `jest.fn()`; objects with methods become objects of `jest.fn()`s; default, named, namespace, and CommonJS imports each get the matching module shape.
- Classes, and objects created when the module loads (`const pool = new Pool()`, `const api = axios.create()`), return one shared mock object. The test file defines a matching variable (`const pool = new Pool()`), so tests configure the same object the source uses.
- Every mock is reset before each test, so each test sets up exactly what it needs, including rejection paths (`mockRejectedValue`) for error handling.
- Packages that are not installed get `{ virtual: true }` mocks, and local paths are rewritten relative to the test file.
- Pure built-ins the source imports (such as `path`) are imported into the test too, so expected values like file paths are built the same way and pass on every operating system.

`fixtures/mocking/` covers the main dependency types, each run through real Jest by Assertloom's test suite:

| Fixture | Dependency | Module system |
| --- | --- | --- |
| `examples/users.ts` | `axios` + `pg` pool created at load | TypeScript ESM |
| `weather.ts` | global `fetch` | TypeScript ESM |
| `orders.cjs` | local `./db.cjs` wrapping `pg` (mocked); `./money.cjs` (kept real) | CommonJS |
| `settings.mjs` | `node:fs/promises` (mocked); `node:path` (kept real) | `.mjs` |
| `esm-project/git.js` | `node:child_process` | `.js` in a `"type": "module"` package |

All five also passed against `gpt-5.4-mini` with 100% line coverage.

Current limitations:

- Modules loaded with dynamic `import()` are not mocked.
- Projects whose Jest config runs native ESM (`transform: {}` with `--experimental-vm-modules`) don't apply `jest.mock()`; the bundled config is not affected.
- Generated TypeScript tests run correctly, but may not pass `tsc` type checking when the model calls mock methods without `jest.mocked(...)`.
- Classes exported by the source are not tested yet.

## Repairing failing tests

When generated tests fail, `generate` sends the model the failing test bodies, a trimmed failure message for each, and the source file marked read-only. It then reruns Jest. For each failing test, the model chooses one of three actions:

- **fix**: replace the test body, for example to correct a wrong expected value or a missing `await`. The new body goes through the same checks as a generated one.
- **skip**: the test looks right and the source looks wrong. The test is kept as `it.skip` with a comment explaining the suspected bug, so a real bug is not hidden by changing the assertion.
- **remove**: the test cannot be made reliable.

Failures are classified before anything is sent. Assertion, runtime, and timeout failures can be repaired, including tests that configured a mock wrongly or not at all. Failures caused by a real network connection (a dependency that was not mocked, for example after `--keep-real`) are set aside, and failures that stop the whole file from running (missing modules, syntax or config problems) end the loop, because editing test bodies cannot fix them.

Limits:

- At most 3 rounds (`--max-attempts 0` to `3`; `--no-repair` turns repair off). The loop also stops when everything passes, when the model proposes no usable fix, or before a round that could exceed `--max-cost`.
- A round that makes a previously passing test fail is undone, and the loop stops.
- Tests still failing at the end are kept as `it.skip` with the reason, so the file runs cleanly and the problems stay visible.
- Repair only writes the generated test file. Every Jest run snapshots the source file first and restores it afterwards if a test changed it.

Use `--report <file>` to save JSON with the results of the first run, every repair round (requested changes, rejected proposals, before/after counts, token usage), and the final run.

`fixtures/repair/` holds a documented set of intentionally failing tests (wrong values, a misspelled function name, a missing `await`, a real bug in the source, and a `fetch` mock the test never configured), with the repairs a model would propose. Assertloom's test suite runs that scenario through real Jest.

## Running tests

`run` executes any test file and reports results and coverage for its source file, which is inferred from the name (`math.test.preview.ts` → `math.ts`) or passed with `--source`.

```bash
npx assertloom run fixtures/runner/failing.test.preview.ts --source fixtures/runner/calc.ts
```

```
! Ran Jest: 1 passed, 3 failed (bundled Jest, Assertloom default config, network blocked, 9.3s)
  ✗ add › has a wrong expectation  [assertion]
      Error: expect(received).toBe(expected) // Object.is equality
      Expected: 5
      Received: 4
  ✗ divide › calls a method that does not exist  [error]
      TypeError: result.toFixedd is not a function
  ✗ sign › waits forever  [timeout]
      Error: thrown: "Exceeded timeout of 5000 ms for a test.
✓ Coverage: 71.4% lines, 66.7% branches, 66.7% functions
```

Add `--json` for the full result and `--timeout <seconds>` to change the 120-second limit.

How the runner works:

- **Jest setup.** Assertloom finds the project root (the nearest `package.json`, without leaving the git repository). If the project has its own Jest config (`jest.config.js/.cjs/.mjs/.json/.ts/.mts/.cts` or a `"jest"` key in `package.json`), Assertloom uses the project's Jest with that config and overrides only test selection and coverage settings. TypeScript configs are loaded with Node's built-in type stripping (Node.js 22.18 or newer; older versions fall back to the default config). Otherwise it uses its bundled Jest with Babel for TypeScript and JSX, so projects without Jest work too. Multi-project configs fall back to the default config for now.
- **Module systems.** The bundled config compiles ESM to CommonJS for Jest, so `.mjs` files, `.js` files in `"type": "module"` packages, `.cjs`, and TypeScript all run without `--experimental-vm-modules`, and `jest.mock()` works the same way in all of them.
- **Isolation.** Jest runs in a child process, one file at a time (`--runInBand`), with a hard timeout and a 5-second per-test timeout. Environment variables that look like credentials (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, and similar) are removed before the tests run.
- **Network.** Network access is blocked by default. A preloaded guard (`--require`, inherited by any Node subprocess the tests start) fails every outgoing TCP connection and DNS lookup with `Assertloom blocked a network connection`, which covers `net`, `http`, `https`, `tls`, and `fetch`. Tests can still start local servers, but cannot connect to them. Pass `--allow-network` to `run` or `generate` to turn the guard off. The guard stops accidental connections from well-behaved code; it is not a sandbox against hostile code (which could, for example, spawn a non-Node process).
- **Results.** Each test is reported as passed, failed, or skipped. Failures are labeled `assertion` (an `expect` did not match), `error` (an exception), or `timeout`. Problems that stop the whole file from running are reported separately as infrastructure failures: `module-not-found`, `transform` (syntax or module-format problems), `suite-error`, `crash`, or `timeout`.
- **Coverage.** Measured with V8 for the source file only, as line, statement, function, and branch percentages.

## Benchmark

`npm run bench` downloads one file from each of nine independent open-source packages, pinned to exact versions (`bench/targets.ts`), and runs the full pipeline on each: generate, run, and repair. It records generation, execution, and repair success rates, runtime, model cost, and coverage. Results are written to `bench/results/latest.json` and `latest.md`, and the final test files to `bench/results/tests/`. It needs `OPENAI_API_KEY`; use `--only ms,cookie` for a subset and `--model` to compare models.

Results from 2026-10-31 with `gpt-5.4-mini`, Node 24.11.1 on Windows, $0.50 limit per file:

| Target | Functions tested | Valid cases | First run | Final | Repair rounds | Lines | Branches | Time | Cost | Mocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ms@2.1.3` index.js | 1/1 | 6/6 | 6/6 | 6/6 passing | 0 | 86.41% | 33.89% | 6.4s | $0.0026 | – |
| `bytes@3.1.2` index.js | 3/3 | 15/15 | 12/15 | 15/15 passing | 1 | 98.23% | 93.47% | 12.6s | $0.0088 | – |
| `escape-html@1.0.3` index.js | 1/1 | 5/5 | 5/5 | 5/5 passing | 0 | 100% | 100% | 6.2s | $0.0024 | – |
| `content-type@1.0.5` index.js | 2/2 | 12/12 | 12/12 | 12/12 passing | 0 | 97.33% | 91.89% | 7.7s | $0.0054 | – |
| `cookie@0.7.2` index.js | 2/2 | 11/11 | 11/11 | 11/11 passing | 0 | 93.73% | 82.66% | 8.0s | $0.0063 | – |
| `camelcase@8.0.0` index.js | 1/1 | 6/6 | 6/6 | 6/6 passing | 0 | 100% | 95.83% | 7.0s | $0.0033 | – |
| `slugify@1.6.6` slugify.js | 0/0 | 0/0 | – | error: no exported functions found | 0 | – | – | 1.8s | $0.0000 | – |
| `semver@7.6.3` functions/inc.js | 1/1 | 5/6 | 4/5 | 5/5 passing | 1 | 100% | 75% | 10.7s | $0.0037 | – |
| `dotenv@16.4.7` lib/main.js | 6/7 | 17/23 | 9/17 | 16/17 passing | 3 | 84.21% | 77.46% | 33.4s | $0.04 | fs, os, crypto |

| Metric | Result |
| --- | --- |
| Test generation (files with valid tests) | 8/9 (88.9%) |
| Test generation (cases passing validation) | 77/84 (91.7%) |
| Execution (files whose tests ran) | 8/9 (88.9%) |
| Execution (tests passing on first run) | 65/77 (84.4%) |
| Repair (initially failing tests fixed) | 11/12 (91.7%) |
| Repair (flagged as source bugs / set aside) | 0 / 1 |
| Final (tests passing) | 76/77 (98.7%) |
| Files with every test passing (none skipped) | 7/9 |
| Line coverage, before → after (mean) | 0% → 95% |
| Branch coverage after (mean) | 81.3% |
| Runtime (total / median per file) | 93.9s / 7.7s |
| Model cost (total / mean per file) | $0.07 / $0.0076 |

How to read it:

- "Coverage before" is 0% because published npm packages don't include their tests. The comparison is with having no tests, not with each project's own suite.
- Model output varies between runs. In four full runs during development, the final pass rate ranged from 82.7% to 98.7%. The lowest came from `dotenv`, where the model tried to stub functions in the same file. The validation rules described under [Generating tests](#generating-tests) now reject that, and this run is the first with those rules. Rerun the benchmark rather than relying on one number.
- Each target is one file, and none is large (the biggest is `dotenv/lib/main.js`, 360 lines). Nine files are enough to find failure patterns, not to estimate a precise success rate.

Limitations found by the benchmark:

- **UMD modules are not recognized.** `slugify` wraps its code in a UMD factory, so the analyzer finds no exports and no tests are generated.
- **Files with much I/O need more repair.** `dotenv` reads files, decrypts with `crypto`, and writes to `process.env`. Only about half of its tests passed on the first run, and repair needed all three rounds. One test was still failing and was kept as `it.skip`.
- **Branch coverage trails line coverage** (81% vs. 95%). The model covers typical paths well but misses rarer branches, such as the unit aliases in `ms`.
- Cases are sometimes rejected for syntax errors or for `require()` calls in the test body. They are dropped rather than retried, which lowers coverage for that file.

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
| `assertloom generate <file> [--model] [--out] [--dry-run] [--no-run] [--no-repair] [--max-attempts] [--report] [--mock] [--keep-real] [--allow-network] [--max-cost] [--force]` | Generate Jest tests for exported functions with dependencies mocked, run and repair them, and keep them if they pass |
| `assertloom run <testFile> [--source] [--timeout] [--allow-network] [--json]` | Run a test file with Jest and report results and coverage |
| `assertloom help [command]` | Show help |

Supported extensions: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`. Missing files, directories, unsupported extensions, existing `*.test.*`/`*.spec.*` files, and files over 1 MB are rejected with exit code 1.

## Development

```bash
npm test          # Vitest
npm run typecheck
npm run build     # outputs to dist/
npm run bench     # live benchmark (needs OPENAI_API_KEY)
```

CI (`.github/workflows/ci.yml`) runs the type check, tests, build, and a CLI smoke test on Linux, Windows, and macOS with Node 22 and 24. It also installs the packed tarball into an empty project and runs it.

## Project layout

```
src/
  cli/         Commander entry point, commands, input validation
  analyzer/    Babel AST analysis: parser, functions, dependencies, import usage
  ai/          LLM provider interface, OpenAI provider, prompts, secret redaction
  generator/   Import and mock planning, response schema, case validation, test file writing
  runner/      Jest setup detection, isolated Jest runs, result parsing, coverage
  repair/      Failure classification and the repair loop
  types/       Shared types
bench/         Benchmark targets, runner, and published results
docs/          Terminal demo recording
examples/      Sample source files and sample-project/
scripts/       Demo recorder
fixtures/      Inputs for Assertloom's own tests
tests/         Assertloom's own tests (Vitest)
```

## Security principles

Assertloom treats target repositories and generated tests as untrusted:

- Analysis is static. Target code is never executed during analysis, including the local modules Assertloom reads to decide what to mock.
- Generated tests run against mocks of packages, databases, the file system, subprocesses, and `fetch`, so they do not reach real services by default.
- Generated tests run in a separate process with a hard timeout, without credential-like environment variables, and with network connections blocked unless you pass `--allow-network`.
- Only the target file is sent to the AI provider. `.env` files and other files are never sent, likely secrets (API keys, tokens, private keys, credentials in URLs, quoted `password`/`secret`/`token` values) are redacted first, and OpenAI requests are made with `store: false`.
- A diff is shown before any existing test file is overwritten, and files that Assertloom did not generate are never overwritten without `--force`.
- The repair loop only edits generated tests, never production source code.
- Retries (at most 3 repair rounds), model spending (`--max-cost`, default $1), and execution time (120 seconds per Jest run, 5 seconds per test) have hard limits.

Generated tests run as normal Node code on your machine; the network guard and timeouts are safeguards, not a sandbox. Only run Assertloom against code you trust, or run it inside a container or VM.

## Roadmap

All eight milestones are done: CLI foundation, AST analyzer, AI test generation, execution engine, self-repair, dependency mocking, evaluation and hardening, and the open-source release. [ROADMAP.md](ROADMAP.md) lists what comes next, starting with the weak spots the benchmark found. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Bug reports, benchmark results on other projects, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities privately.

Releases are published to npm by the [release workflow](.github/workflows/release.yml) when a `v*` tag is pushed, with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) linking each version to the commit and workflow run that built it.

## License

[MIT](LICENSE)
