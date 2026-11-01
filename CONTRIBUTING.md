# Contributing to Assertloom

Thanks for helping. Bug reports, benchmark results on new projects, and pull requests are all welcome.

## Setup

You need Node.js 22 or newer and git.

```bash
git clone https://github.com/Ish0212/Assertloom.git
cd Assertloom
npm install
npm test            # Vitest: unit tests plus real Jest runs, no API key needed
npm run typecheck
npm run build
```

Run the CLI from source with `npm run dev -- <command>`, for example `npm run dev -- analyze examples/math.ts`.

The test suite never calls a real model. Tests that need model output use `tests/helpers/fakeProvider.ts` with scripted responses (see `fixtures/repair/scenario.ts` and `fixtures/mocking/scenarios.ts`). Only `generate` and `npm run bench` need `OPENAI_API_KEY`.

## Where things live

| Directory | What it does |
| --- | --- |
| `src/analyzer/` | Static analysis with Babel. Never executes target code. |
| `src/generator/` | Mock planning, prompt inputs, validation of model output, and writing test files |
| `src/ai/` | Provider interface, OpenAI provider, prompts, pricing, secret redaction |
| `src/runner/` | Jest setup detection, isolated runs, network guard, coverage |
| `src/repair/` | Failure classification and the repair loop |
| `src/ci/` | `assertloom ci`: changed-file selection, the multi-file run with a shared budget, reports |
| `action.yml` | The GitHub Action, a thin wrapper that installs Assertloom and runs `assertloom ci` |
| `bench/` | Benchmark targets and runner |
| `fixtures/` | Inputs for the test suite |

## Pull requests

1. Open an issue first for larger changes, so we can agree on the approach.
2. Add or update tests. Bug fixes should include a test that fails without the fix.
3. Run `npm run typecheck` and `npm test` before pushing. CI runs both on Linux, Windows, and macOS with Node 22 and 24.
4. Keep the README accurate. If behavior or output changes, update the relevant section.
5. Add a line under "Unreleased" in `CHANGELOG.md`.

If you change `action.yml` or `src/ci/`, `npm test` covers selection, budgets, reports, and redaction with a scripted model (`tests/ci.test.ts`, using the fixture pull request from `fixtures/ci/makeConsumer.mjs`). The "Action check" workflow then runs the action itself in dry-run mode. To try it against a real model, start that workflow by hand with **live** checked; it uses the repository's `OPENAI_API_KEY` secret and spends at most $0.05. Keep every `${{ }}` expression out of `run:` scripts in `action.yml` (pass values through `env:`); a test enforces this.

When releasing, set `assertloom-version` in `action.yml` to the new version. The release workflow refuses a tag that doesn't match.

If you change prompts, validation rules, mocking, or repair, please run `npm run bench` (or a subset with `--only`) and include the before/after summary in the pull request. A full run costs under $0.15 with the default model.

## Safety rules

These are part of Assertloom's design. Pull requests that weaken them won't be merged:

- Analysis stays static: never `require`, `import`, or evaluate target code to analyze it.
- Generated tests run in a separate process with timeouts, without credential-like environment variables, and with network access blocked by default.
- Only the target file (with likely secrets redacted) is sent to a model. Never send `.env` files, credentials, or unrelated files.
- Repair only edits generated test files, never source code.
- Retries, spending, and execution time keep hard limits.

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
