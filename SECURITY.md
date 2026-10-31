# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/Ish0212/Assertloom/security/advisories/new), not in public issues. Include the version, your operating system and Node.js version, and steps to reproduce.

You should get a reply within a week. Fixes are released as a patch version and noted in the changelog.

## Supported versions

Only the latest published version receives security fixes while Assertloom is below 1.0.

## Threat model

Assertloom runs tests that a language model wrote against code it may not know. Its safeguards:

- **Static analysis.** Target code is parsed, never executed, during analysis.
- **Data sent to the model.** Only the target file, with likely secrets redacted. OpenAI requests use `store: false`.
- **Test runs.** A separate process with a hard timeout, credential-like environment variables removed, and outgoing network connections blocked unless `--allow-network` is passed.
- **Source protection.** Repair only edits generated tests. The source file is hashed before and after every run and restored if it changed.
- **Limits.** At most 3 repair rounds, a spending limit (`--max-cost`), and time limits per run and per test.

The network guard and timeouts protect against mistakes in generated tests and well-behaved code. They are not a sandbox: generated tests run as ordinary Node.js code with your user's file system permissions. Run Assertloom inside a container or VM for code you don't trust.
