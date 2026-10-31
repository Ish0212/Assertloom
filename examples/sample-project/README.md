# Assertloom sample project

A small store backend for trying Assertloom. Each file has no tests yet, and each needs something different:

| File | What it does | What Assertloom has to handle |
| --- | --- | --- |
| `src/cart.js` | Subtotals, discount codes, price formatting | Pure logic with edge cases and thrown errors |
| `src/rates.js` | Exchange rates over HTTP with `fetch` | Mocking global `fetch`, success and failure responses |
| `src/config.js` | Reads `store.json` with `fs/promises` | Mocking the file system, missing-file fallback, validation errors |

## Try it

You need Node.js 22 or newer and an OpenAI API key.

```bash
# Copy this folder somewhere (or clone the repository and cd into it)
cd examples/sample-project
npm install                      # installs assertloom from npm

export OPENAI_API_KEY=sk-...     # PowerShell: $env:OPENAI_API_KEY = "sk-..."

npx assertloom analyze src/cart.js
npx assertloom generate src/cart.js
npx assertloom generate src/rates.js
npx assertloom generate src/config.js
```

Or run all three with `npm run generate`.

## What you should see

`generate` analyzes the file, mocks dependencies, asks the model for tests, runs them with network access blocked, repairs failures, and saves the file when everything passes:

```
Generating tests for src/rates.js with openai (gpt-5.4-mini)...
✓ Analyzed 2 exported functions (2 tested)
✓ Mocked 1 dependency: global fetch
✓ Generated 8 test cases (3 normal, 2 edge, 3 error)
  Tokens: 1,115 in / 734 out, ≈$0.0041 (gpt-5.4-mini-2026-03-17)
✓ Ran Jest: 8 passed, 0 failed (bundled Jest, Assertloom default config, network blocked, 20.7s)
✓ Coverage: 100% lines, 100% branches, 100% functions

Tests saved to src/rates.test.js
```

Model output varies, so your counts will differ. Some runs need a repair round, and a test that still fails after three rounds is kept as `it.skip` with the reason as a comment. In our runs, each file cost less than one cent and reached 100% line coverage.

Run the saved tests again at any time:

```bash
npx assertloom run src/cart.test.js
```

The project doesn't need Jest installed. Assertloom runs the tests with its bundled Jest, which handles this project's ES modules (`"type": "module"`) without extra configuration.
