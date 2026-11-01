# Assertloom benchmark

- Date: 2026-11-01
- Assertloom: 0.1.0
- Model: gpt-5.4-mini (openai)
- Prices: standard API rates checked 2026-10-31
- Node: v24.11.1
- OS: win32 x64
- Spending limit: $0.5 per file
- Coverage before: 0% for every file (published npm packages ship without their tests)

| Target | Functions tested | Valid cases | First run | Final | Repair rounds | Lines | Branches | Time | Cost | Mocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ms@2.1.3` index.js | 1/1 | 6/6 | 4/6 | 6/6 passing | 1 | 88.88% | 50.81% | 18.0s | $0.0056 | – |
| `bytes@3.1.2` index.js | 3/3 | 15/15 | 12/15 | 15/15 passing | 2 | 97.64% | 90.9% | 16.5s | $0.0093 | – |
| `escape-html@1.0.3` index.js | 1/1 | 5/5 | 5/5 | 5/5 passing | 0 | 100% | 100% | 6.1s | $0.0026 | – |
| `content-type@1.0.5` index.js | 2/2 | 9/10 | 9/9 | 9/9 passing | 0 | 96.44% | 88.88% | 7.3s | $0.0053 | – |
| `cookie@0.7.2` index.js | 2/2 | 10/10 | 10/10 | 10/10 passing | 0 | 92.83% | 78.57% | 7.9s | $0.0056 | – |
| `camelcase@8.0.0` index.js | 1/1 | 6/6 | 5/6 | 6/6 passing | 1 | 98.18% | 91.48% | 29.9s | $0.0053 | – |
| `slugify@1.6.6` slugify.js | 1/1 | 5/5 | 4/5 | 5/5 passing | 2 | 86.95% | 92% | 13.9s | $0.01 | – |
| `semver@7.6.3` functions/inc.js | 1/1 | 5/6 | 4/5 | 5/5 passing | 1 | 100% | 75% | 10.8s | $0.0037 | – |
| `dotenv@16.4.7` lib/main.js | 3/7 | 12/25 | 11/12 | 12/12 passing | 1 | 36.56% | 82.35% | 22.2s | $0.02 | fs, os, crypto |

| Metric | Result |
| --- | --- |
| Test generation (files with valid tests) | 9/9 (100%) |
| Test generation (cases passing validation) | 73/88 (83%) |
| Execution (files whose tests ran) | 9/9 (100%) |
| Execution (tests passing on first run) | 64/73 (87.7%) |
| Repair (initially failing tests fixed) | 9/9 (100%) |
| Repair (flagged as source bugs / set aside) | 0 / 0 |
| Final (tests passing) | 73/73 (100%) |
| Files with every test passing (none skipped) | 9/9 |
| Line coverage, before → after (mean) | 0% → 88.6% |
| Branch coverage after (mean) | 83.3% |
| Runtime (total / median per file) | 132.6s / 13.9s |
| Model cost (total / mean per file) | $0.07 / $0.0080 |
| Tokens (in / out) | 45,040 / 8,485 |
