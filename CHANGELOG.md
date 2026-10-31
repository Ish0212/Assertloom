# Changelog

All notable changes to Assertloom are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

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
