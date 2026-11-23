# Tests

These folders check the code. To adopt it, see [`adopt-example/`](../adopt-example/): nothing here is needed for that.

| Folder | What it checks |
|---|---|
| [`library/`](./library/) | [`execution-state-preflight.js`](../execution-state-preflight.js), offline. It also holds the harness and raw results of the repeated-run test the [case report](../case-muse-marketplace.en.md) cites |
| [`adopt/`](./adopt/) | [`adopt-example/`](../adopt-example/) (`judge-only.js`, `middleware.js`, `agent.js`, `connect.js`, `records.js`) with stand-in models, and [`trial-real-model.js`](./adopt/trial-real-model.js), one run with a real model |

```bash
cd tests
npm run check        # every check, no API calls; installs adopt-example's packages first
```

Until November 2026 these were `hooks-example/` and `provider-checklist-example/`, with an earlier flow in `adopt-example/gate.js`. That state is at commit [`b73cf09`](https://github.com/Jang-woo-AnnaSoft/execution-state-preflight/tree/b73cf09).
