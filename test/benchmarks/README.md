# Popup Benchmark Setup

The real-Chrome popup benchmark needs a browser binary. On Debian 12 in this workspace, the repo ships a command for that:

```bash
bun run install-chrome
```

That command installs Chromium plus the small display helpers the benchmark uses in headless environments (`xauth` and `xvfb`). The benchmark will then discover `/usr/bin/chromium` automatically.

If you already have Chrome installed elsewhere, point the benchmark at it directly:

```bash
CHROME_BIN=/path/to/chrome bun run benchmark:popup-lifecycle
```

The real browser benchmark now uses the extension's built-in mainnet RPC configuration, so network latency is part of the measurement. It also opens the popup through the extension action API and fails if that API is unavailable.
It also prints the RPC methods observed during the run and their durations, grouped by method.

The benchmark is:

```bash
bun run benchmark:popup-lifecycle
```

It currently reports the `cold`, `warm`, and `stacked` popup-open scenarios. The `stacked` scenario opens a real local HTTP test page that first requests account access, then sends one `eth_sendTransaction`, waits for the confirm popup, fetches the user's balance, and then opens the main popup.

For `stacked`, the output is split into two timing families:

- `send transaction path / ...` starts when the transaction test page loads. These timings include the webpage, confirm popup, and background work before the main popup is opened.
- `main popup only / ...` starts later, exactly when the benchmark requests the main popup to open. These timings exclude the send-transaction setup path.

The `stacked` report also includes an end-to-end section that combines both halves into the full path:

- load webpage
- send transaction
- wait for transaction popup
- query balance
- open main popup
- main popup rendered

Run just the stacked case with:

```bash
BENCH_SCENARIO=stacked bun run benchmark:popup-lifecycle
```

The real browser benchmark does not seed `browser.storage.local` and it does not use a local JSON-RPC fixture server.
For the `stacked` scenario, it prints the send-transaction setup phases, the end-to-end send-transaction-to-main-popup path, the RPCs from the transaction/balance setup, and the RPCs observed while the main popup itself is opening.
