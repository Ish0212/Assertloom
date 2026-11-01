# GitHub Action

The Assertloom action generates Jest tests for the JavaScript and TypeScript files a pull request changes. It runs them, repairs failing tests, and uploads the results for review: the generated tests, a JSON report, and a Markdown summary that also appears on the workflow run page.

It never commits, pushes, comments, opens pull requests, or changes repository settings. Generated tests are previews: you read them in the artifact and decide what to keep.

- [Quick start](#quick-start)
- [Secrets](#secrets)
- [Inputs](#inputs) and [outputs](#outputs)
- [Which files are processed](#which-files-are-processed)
- [Budget](#budget)
- [Failure policy and exit behavior](#failure-policy-and-exit-behavior)
- [Artifacts](#artifacts)
- [Security and trust](#security-and-trust)
- [Example job summary](#example-job-summary)
- [Running it locally](#running-it-locally)
- [Limitations](#limitations)

## Quick start

1. Add an `OPENAI_API_KEY` secret to your repository (see [Secrets](#secrets)).
2. Copy [`examples/github-action/assertloom.yml`](../examples/github-action/assertloom.yml) to `.github/workflows/assertloom.yml`:

```yaml
name: Assertloom

on:
  pull_request:
  workflow_dispatch:
    inputs:
      files:
        description: Newline-separated files to generate tests for
        required: true

permissions:
  contents: read

concurrency:
  group: assertloom-${{ github.ref }}
  cancel-in-progress: true

jobs:
  generate-tests:
    # Pull requests from forks run code you have not reviewed and get no secrets, so skip them.
    # Dependabot pull requests get no Actions secrets either.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]')
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # the base commit must be available to find changed files
          persist-credentials: false # keep the GitHub token out of reach of generated tests

      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm

      # Generated tests import your code, so its dependencies must be installed.
      - run: npm ci

      - uses: Ish0212/Assertloom@v0.2.0 # or pin a full commit SHA
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          files: ${{ inputs.files }}
          max-files: "10"
          max-cost: "0.50"
```

3. Open a pull request that changes a `.js` or `.ts` file. When the run finishes, the summary is on the run page and the tests are in the `assertloom-report` artifact.

To run it on specific files without a pull request, start the workflow from the Actions tab and list the files.

Requirements: Node.js 22 or newer on the runner (the action checks and stops with a message otherwise), a checkout with full history (`fetch-depth: 0`), and your project's dependencies installed. The action installs its own Jest when your project has none.

### Pinning

`Ish0212/Assertloom@v0.2.0` runs the action as released in that tag, and the action installs exactly `assertloom@0.2.0` from npm. It never installs a range or `latest`. For the strongest guarantee against a moved tag, pin the commit SHA of the release instead: `Ish0212/Assertloom@<40-character SHA> # v0.2.0`.

## Secrets

The provider key is passed explicitly with `api-key`. The action never reads secrets on its own.

1. In your repository, open **Settings → Secrets and variables → Actions → New repository secret**.
2. Name it `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) and paste the key.
3. Pass it to the action: `api-key: ${{ secrets.OPENAI_API_KEY }}`.

For Anthropic:

```yaml
      - uses: Ish0212/Assertloom@v0.2.0
        with:
          provider: anthropic
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

For an OpenAI-compatible server (OpenRouter, a self-hosted vLLM, and so on), a model and a token limit are required because these models have no known price:

```yaml
      - uses: Ish0212/Assertloom@v0.2.0
        with:
          provider: openai-compatible
          base-url: https://openrouter.ai/api/v1
          model: qwen/qwen3-coder
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
          max-tokens: "400000"
```

How the key is handled:

- Only the environment variable for the selected provider is set, and only for the step that runs Assertloom.
- Before generated tests run, Assertloom removes every environment variable whose name looks like a credential (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*AUTH*`, and similar), so test processes don't inherit the key.
- The key's exact value, and anything shaped like a key or token, is replaced with `<redacted>` in `report.json`, `summary.md`, the job summary, and log lines Assertloom writes. GitHub also masks secret values in logs.
- Source code is sent to the provider with likely secrets redacted, as with `assertloom generate`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `provider` | `openai` | `openai`, `anthropic`, or `openai-compatible` |
| `model` | provider default | `gpt-5.4-mini` for openai, `claude-haiku-5-5` for anthropic. Required for openai-compatible. |
| `api-key` | | Provider API key, from a secret |
| `base-url` | | Server URL for openai-compatible |
| `files` | | Newline-separated files to process instead of the pull request diff |
| `base` | the pull request's base commit | Commit to diff against |
| `head` | `HEAD` | Commit whose changes are processed |
| `include` | | Only consider files matching these globs (newline- or comma-separated), such as `src/**` |
| `exclude` | | Also skip files matching these globs |
| `default-excludes` | `true` | Skip tests, dependencies, build output, declarations, minified, and generated files ([list](#which-files-are-processed)) |
| `max-files` | `10` | Process at most this many files |
| `max-cost` | `1` | Spending limit in US dollars for the whole run |
| `max-tokens` | | Shared token limit for the whole run; required for models without a known price |
| `max-attempts` | `3` | Repair rounds per file, 0 to 3 |
| `timeout` | `120` | Seconds allowed for each test run |
| `fail-on` | `errors` | `never`, `errors`, or `tests` ([details](#failure-policy-and-exit-behavior)) |
| `working-directory` | `.` | Directory inside the repository to run in |
| `report-dir` | `$RUNNER_TEMP/assertloom-report` | Where `report.json`, `summary.md`, and `tests/` are written; outside the checkout by default |
| `upload-artifact` | `true` | Upload the report directory as an artifact |
| `artifact-name` | `assertloom-report` | Artifact name; change it if the action runs more than once in a workflow |
| `retention-days` | `14` | Days to keep the artifact |
| `dry-run` | `false` | Select files and write the report without calling a model or running tests; needs no key |
| `assertloom-version` | the release's version | Exact npm version to install; keep the default |
| `assertloom-tarball` | | Local `.tgz` to install instead, for testing the action before a release |

## Outputs

| Output | Description |
| --- | --- |
| `result` | `passed`, `failed` (the `fail-on` policy was violated), or `error` (Assertloom could not run) |
| `report-dir`, `report-path`, `summary-path` | Locations of the results |
| `files-selected` | Eligible changed files |
| `files-processed` | Files whose tests were generated and run |
| `files-skipped` | Files skipped for any reason, including the file and budget limits |
| `files-failed` | Selected files that could not be processed |
| `tests-final-passed`, `tests-final-failed` | Generated tests passing and failing at the end |
| `budget-exhausted` | `true` if the spending limit stopped the run early |
| `artifact-id` | ID of the uploaded artifact |

## Which files are processed

For a pull request, Assertloom lists the files changed on `head` since it branched from `base` (`git diff base...head`), with rename detection. Then:

| Change | Handling |
| --- | --- |
| Added, modified | processed if eligible |
| Renamed, copied | the new path is processed if eligible; the report records the old path |
| Deleted | reported as skipped (`deleted`) |

A file is eligible if it has a supported extension (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`), matches `include` (when given), matches no exclusion, is a regular file inside the repository (not a symlink), is at most 1 MB, and isn't marked generated (`@generated`, `DO NOT EDIT`). A file with no exported functions is skipped after analysis.

Default exclusions (turn them off with `default-excludes: false`):

```
**/node_modules/**  **/dist/**  **/build/**  **/out/**  **/coverage/**  **/vendor/**
**/.next/**  **/.nuxt/**  **/__tests__/**  **/__mocks__/**  **/__generated__/**
**/*.test.*  **/*.spec.*  **/*.d.ts  **/*.d.mts  **/*.d.cts  **/*.min.js  **/*.generated.*
```

Globs support `**`, `*`, `?`, and `{a,b}`. A pattern without `/` matches the file name at any depth.

Files are processed in path order, up to `max-files`. Every changed file appears in the report, with the reason it was skipped if it was.

File names and event data are treated as untrusted. They reach Assertloom through environment variables and argument arrays, never through a shell command line, and they are escaped in the Markdown summary. Names with spaces, quotes, `$(...)`, or other unusual characters work.

If the base commit is missing (usually a shallow checkout), the run stops with a message telling you to use `fetch-depth: 0`.

## Budget

`max-cost` is one limit for the entire run, shared by every file's generation call and every repair round. It is not a per-file limit. Before each model call, Assertloom checks the worst case (the full prompt plus the maximum output) against what is left. If that call could exceed the limit, it isn't made. Assertloom then starts no new files, and the remaining files are reported as skipped (`budget`). The summary shows **Budget exhausted** and the `budget-exhausted` output is `true`.

Costs use Assertloom's built-in price table for OpenAI and Anthropic models. For models without a known price, a dollar limit can't be enforced, so `max-tokens` is required. It caps input plus output tokens across the whole run, and the summary reports the cost as unknown.

The estimated cost in the summary comes from token counts and published prices. Check your provider's dashboard for billed amounts.

## Failure policy and exit behavior

A successful step does **not** mean every generated test passed. Generated tests are proposals, and failing or skipped ones are expected and visible in the summary. The step's exit status follows `fail-on`:

| `fail-on` | The step fails when |
| --- | --- |
| `never` | Assertloom cannot run at all (bad input, missing base commit, missing key) |
| `errors` (default) | the above, or any selected file could not be processed: the model call failed, no usable tests came back, the tests could not run (missing module, syntax error, crash), or a test run timed out |
| `tests` | the above, or any processed file ends with a failing test, a test skipped by repair (suspected source bug or repair gave up), or a test removed by repair |

Skipping files because of `max-files` or the budget doesn't fail the step under any policy. Use the `budget-exhausted` output if you want it to.

The summary and artifact are written even when the step fails, including partial results if a run stops partway. The upload step runs with `if: always()`.

## Artifacts

The artifact contains only what Assertloom writes to the report directory:

```
report.json                                 machine-readable results (schema below)
summary.md                                  the job summary
tests/<path of source>.test.preview.<ext>   generated tests, one file per processed source
```

It contains no source files, environment files, `node_modules`, or secrets. To use a generated test, copy it next to its source file and rename `.test.preview.` to `.test.`.

`report.json` (abridged):

```jsonc
{
  "schemaVersion": 1,
  "assertloom": "0.2.0",
  "mode": "pull-request",            // or "files"
  "provider": "openai", "model": "gpt-5.4-mini",
  "limits": { "maxFiles": 10, "maxCostUsd": 1, "maxTokens": null, "maxAttempts": 3, "timeoutSeconds": 120 },
  "budget": { "exhausted": false, "costKnown": true, "spentUsd": 0.0126, "tokens": { "input": 7200, "output": 1600 } },
  "totals": { "files": { ... }, "tests": { ... }, "regressions": 0, "infrastructureFailures": 0, "durationMs": 10500 },
  "policy": { "failOn": "errors", "failed": false, "reasons": [] },
  "files": [
    {
      "path": "src/pricing.js", "change": "modified", "status": "processed",
      "generated": 3, "accepted": 3, "rejected": 0,
      "initial": { "status": "failed", "passed": 2, "failed": 1, "skipped": 0 },
      "final": { "status": "passed", "passed": 3, "failed": 0, "skipped": 0, "coverage": { "lines": 100, "branches": 100, ... } },
      "repaired": 1, "flaggedAsSourceBugs": 0, "removed": 0, "gaveUp": 0,
      "repairRounds": 1, "regressions": 0, "stopReason": "all-passing",
      "durationMs": 5400, "usage": { "inputTokens": 3600, "outputTokens": 800 }, "costUsd": 0.0063,
      "artifact": "tests/src/pricing.test.preview.js"
    },
    { "path": "src/legacy.js", "change": "deleted", "status": "skipped", "skipReason": "deleted", ... }
  ]
}
```

`repaired` counts tests that failed on the first run and pass at the end. Tests skipped as suspected source bugs (`flaggedAsSourceBugs`), tests skipped after repair gave up (`gaveUp`), and tests removed by repair (`removed`) are counted separately and never as repairs.

## Security and trust

Generated tests and the code they import run on the runner as ordinary Node.js code. Assertloom's network guard, timeouts, and environment scrubbing are safeguards, **not a sandbox**: code that is written to escape them can.

What follows from that:

- **Never run this action on code you don't trust with your provider key.** The example skips pull requests from forks. On the `pull_request` event GitHub doesn't give fork pull requests secrets anyway, so without the `if:` those runs would fail rather than leak. Don't change the trigger to `pull_request_target` to get secrets for forks: that would run untrusted pull request code with your secrets.
- **Same-repository branches are trusted.** Anyone who can push a branch to your repository can change the code that runs in this job. A malicious branch could read the provider key from the Assertloom process (test processes don't inherit it, but they run as the same user). Only use the action in repositories where everyone with write access may use the key, and prefer a dedicated key with a spending cap set at the provider.
- **No write token is exposed.** The example grants `contents: read`, and Assertloom needs nothing more. Use `persist-credentials: false` on checkout so the job's token isn't stored in `.git/config` where tests could read it. The action warns if it finds one there. Assertloom never needs `GITHUB_TOKEN`, and its test processes get no variables with `TOKEN` in the name.
- **Network access is blocked** for generated tests by default (Node's `net`, `http`, `https`, `tls`, `fetch`, and DNS). Non-Node subprocesses started by tests are not covered.
- **Nothing is written back.** Previews are written next to their source files in the runner's checkout (so relative imports resolve), copied to the report directory, and deleted. Existing files are never overwritten; a file whose preview name is already taken is skipped. If a test modifies a source file, Assertloom restores it. The checkout is discarded with the runner.
- `npm install` of Assertloom runs with `--ignore-scripts`.

## Example job summary

This summary came from running the action's command on the consumer fixture in this repository ([`fixtures/ci/makeConsumer.mjs`](../fixtures/ci/makeConsumer.mjs)) with a scripted test model, not a real one. The token counts and cost come from the script.

> ## Assertloom: generated tests for changed files
>
> **✅ Completed (fail-on: errors).** Generated tests are previews for review. A completed run does not mean every generated test passed.
>
> | | |
> | --- | --- |
> | Files | 11 changed, 4 selected, 3 processed, 8 skipped, 0 failed |
> | Test cases | 5 generated, 5 accepted, 0 rejected by validation |
> | First run (passed / failed / skipped) | 4 / 1 / 0 |
> | Final run (passed / failed / skipped) | 5 / 0 / 0 |
> | Repair | repaired: 1; skipped as suspected source bugs: 0; skipped after repair gave up: 0; removed: 0 |
> | Regressions (reverted repair rounds) | 0 |
> | Infrastructure failures | 0 |
> | Runtime | 10.5s |
> | Model | gpt-5.4-mini (openai) |
> | Tokens (in / out) | 7,200 / 1,600 |
> | Estimated cost | ≈$0.01 |
>
> ### Files
>
> | File | Status | Cases | First run | Final run | Repaired | Skipped / removed | Lines | Branches | Time | Cost |
> | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
> | src/pricing.js | processed | 3/3 | 2 / 1 / 0 | 3 / 0 / 0 | 1 | 0 / 0 | 100% | 100% | 5.4s | $0.0063 |
> | src/tax $(echo pwned) &#38; 'rates'.js | processed | 1/1 | 1 / 0 / 0 | 1 / 0 / 0 | 0 | 0 / 0 | 100% | 100% | 2.6s | $0.0032 |
> | src/text/slug helper.js | processed | 1/1 | 1 / 0 / 0 | 1 / 0 / 0 | 0 | 0 / 0 | 100% | 100% | 2.6s | $0.0032 |
>
> Skipped files (8): `dist/bundle.js` (excluded), `notes.md` (unsupported type), `src/client.js` (generated file), `src/constants.js` (no exported functions), `src/legacy.js` (deleted), `src/pricing.test.js` (excluded), `src/schema.generated.js` (excluded), `src/types.d.ts` (excluded)

## Running it locally

The action runs `assertloom ci`, which you can also run yourself from a repository checkout:

```bash
npx assertloom@0.2.0 ci --base origin/main --max-cost 0.25         # files changed since origin/main
npx assertloom@0.2.0 ci --files "src/price.ts" --out /tmp/assertloom
npx assertloom@0.2.0 ci --base origin/main --dry-run                # which files would be processed; no key needed
```

Results go to `assertloom-report/` by default (`--out` to change it). Assertloom only writes into an empty directory or one holding a previous report. Run `assertloom ci --help` for every option; each input above has a matching flag.

## Limitations

- Only Jest is used. Projects that only work with Vitest, or whose Jest config runs native ESM, may not run the generated tests (see the main README).
- Files are processed one at a time, so large pull requests take a while. `max-files` and `timeout` bound the run.
- Only exported functions are tested. Classes and methods outside `module.exports` are not.
- The secret isolation described above is not a sandbox; it does not protect against malicious code in the repository.
- The action installs Assertloom from npm at an exact version, but its dependencies resolve within their semver ranges at install time; there is no lockfile for them.
- Previews are written into the checkout for the duration of each file's run. If the job is cancelled mid-file, the preview may remain in the runner's checkout, which is discarded with the runner.
- Prices are a built-in table (checked 2026-10-31); new models without a known price need `max-tokens`.
