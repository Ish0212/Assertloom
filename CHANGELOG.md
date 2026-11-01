# Changelog

All notable changes to Assertloom are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `--provider anthropic` (Claude models, `ANTHROPIC_API_KEY`) and `--provider openai-compatible` with `--base-url` for Ollama, LM Studio, vLLM, OpenRouter, and other servers with the OpenAI Chat Completions API. Claude prices are included in the spending limit.
- UMD modules: exports returned by a UMD factory are analyzed and tested. `slugify` in the benchmark now gets tests.
- The benchmark takes `--provider` and `--base-url`.

### Changed

- Releases are published with npm trusted publishing (OIDC) instead of a stored token.
- Benchmark rerun with the 0.1.0 review fixes and UMD support: 73/73 kept tests pass and mean line coverage is 88.6% across 9 files.

## 0.1.0 - 2026-10-31

First public release.

### Added

- `assertloom analyze`: static analysis of functions, parameters, types, imports, and per-function dependencies for ESM, CommonJS, TypeScript, and JSX.
- `assertloom generate`: Jest tests for every exported function, generated with OpenAI structured outputs (default model `gpt-5.4-mini`), validated case by case, and written to a preview file until they pass.
- Dependency mocking: `jest.mock()` factories shaped from static usage for packages, Node built-ins with side effects, impure local modules, and global `fetch`, with `--mock` and `--keep-real` overrides.
- Self-repair: up to three rounds that fix, skip (suspected source bug), or remove failing tests. Regressions are reverted, unchanged or invalid proposals are rejected, and leftover failures are kept as `it.skip` with the reason.
- `assertloom run`: runs any test file with the project's Jest or the bundled Jest, and reports results and V8 coverage.
- Safeguards: network access blocked in test runs (`--allow-network` to opt in), credential-like environment variables removed, secrets redacted before sending, spending limit (`--max-cost`, default $1), time limits, a diff before overwriting existing tests, and source files restored if a test modifies them.
- Cost tracking in output and `--report` JSON.
- Benchmark harness (`npm run bench`) over nine pinned open-source packages, with published results.
- Sample project in `examples/sample-project`.

### Fixed

- Jest runs on files outside any npm project. Jest 30 also resolves a config from its working directory and failed when none existed.
- Coverage is found when the source path goes through a symlink or a Windows short name (macOS temp directories, CI runners).
- Only the generated test file runs: other test files with the same name, project `roots`, and `testPathIgnorePatterns` no longer change which tests run.
- Timers or sockets left open by the code under test no longer turn a finished run into a timeout (`--forceExit`).
- Every Jest run, not just repair rounds, restores the source file if a test changed it.
- Test-body validation catches indirect access to `require`, `process`, `eval`, and forbidden `jest` methods, optional calls, and bodies that escape their test function.
- Exports named with reserved words or non-identifier keys get safe import names.
- Secret redaction covers Stripe keys, Bearer tokens, quoted keys, and comparisons.
- The network guard also blocks `dns.Resolver` queries and reverse lookups.
- Re-exports are followed when deciding whether a local module needs mocking; multi-line template literals in test bodies keep their exact text.
