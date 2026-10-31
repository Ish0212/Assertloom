# Roadmap

Assertloom was built in eight milestones. All eight are done; what comes next is driven by the [benchmark](README.md#benchmark) and by issues.

## Done

1. **CLI foundation.** Commander CLI, input validation, project layout.
2. **AST code analyzer.** Functions, parameters, types, imports, and per-function dependencies, from ESM, CommonJS, TypeScript, and JSX.
3. **AI test generation.** Structured output from the model, validation of every case, and preview files.
4. **Execution engine.** Isolated Jest runs with the project's or the bundled Jest, failure classification, and V8 coverage.
5. **Self-repair engine.** Up to three repair rounds that fix, skip (suspected source bug), or remove failing tests, with regressions reverted.
6. **Dependency mocking.** Mocks for packages, built-ins, local modules, and `fetch`, shaped from static usage.
7. **Evaluation and hardening.** Network guard, spending limit, cost tracking, overwrite diffs, benchmark on nine open-source packages, and CI.
8. **Open-source release.** npm package with provenance, documentation, sample project, and contribution guidelines.

## Next

Ordered roughly by impact on the benchmark:

- **Retry rejected cases.** Cases rejected by validation (syntax errors, forbidden calls) are dropped today. Sending them back once with the reason should recover most of them.
- **Branch-aware generation.** Branch coverage trails line coverage (81% vs. 95%). Pass the model the branches the first run missed and ask for tests that reach them.
- **Classes.** Generate tests for exported classes and their methods.
- **UMD and factory exports.** Recognize `module.exports = factory()` and UMD wrappers such as `slugify`'s.
- **Directory mode.** `assertloom generate src/` to process many files with one spending limit and a summary.
- **More providers.** Anthropic, Google, and local models through the existing provider interface.
- **Vitest output.** Generate Vitest tests for projects that use it.
- **Stronger isolation.** Optional container runs for untrusted code.

Have an idea or a project where Assertloom does poorly? [Open an issue](https://github.com/Ish0212/Assertloom/issues/new/choose).
