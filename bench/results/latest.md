# Assertloom benchmark

- Date: 2026-10-31
- Assertloom: 0.1.0
- Model: gpt-5.4-mini
- Prices: OpenAI standard rates checked 2026-10-31
- Node: v24.11.1
- OS: win32 x64
- Spending limit: $0.5 per file
- Coverage before: 0% for every file (published npm packages ship without their tests)

| Target | Functions tested | Valid cases | First run | Final | Repair rounds | Lines | Branches | Time | Cost | Mocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ms@2.1.3` index.js | 1/1 | 6/6 | 6/6 | 6/6 passing | 0 | 86.41% | 33.89% | 6.4s | $0.0026 | – |
| `bytes@3.1.2` index.js | 3/3 | 15/15 | 12/15 | 15/15 passing | 1 | 98.23% | 93.47% | 12.6s | $0.0088 | – |
| `escape-html@1.0.3` index.js | 1/1 | 5/5 | 5/5 | 5/5 passing | 0 | 100% | 100% | 6.2s | $0.0024 | – |
| `content-type@1.0.5` index.js | 2/2 | 12/12 | 12/12 | 12/12 passing | 0 | 97.33% | 91.89% | 7.7s | $0.0054 | – |
| `cookie@0.7.2` index.js | 2/2 | 11/11 | 11/11 | 11/11 passing | 0 | 93.73% | 82.66% | 8.0s | $0.0063 | – |
| `camelcase@8.0.0` index.js | 1/1 | 6/6 | 6/6 | 6/6 passing | 0 | 100% | 95.83% | 7.0s | $0.0033 | – |
| `slugify@1.6.6` slugify.js | 0/0 | 0/0 | – | error: No exported functions in package/slugify.js. | 0 | – | – | 1.8s | $0.0000 | – |
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
| Tokens (in / out) | 35,243 / 9,390 |
