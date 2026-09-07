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

To reuse an existing Chrome profile instead of a temporary one, set `CHROME_USER_DATA_DIR` or `INTERCEPTOR_CHROME_PROFILE_DIR`:

```bash
CHROME_USER_DATA_DIR=/path/to/profile bun run benchmark:popup-lifecycle
```

When either env var is set, the benchmark keeps that profile directory instead of deleting it on exit. This is useful when a site requires a one-time interactive check, because you can solve it once in that profile and then rerun the benchmark or other Chrome harness scripts against the same session state.

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

## Switching controls with controlled delays

After `bun run setup-chrome`, run:

```bash
bun run benchmark:popup-switching
```

This benchmark uses the existing Chromium/CDP harness, an isolated temporary profile, a local JSON-RPC fixture, and an EIP-6963 fake wallet. Each iteration starts a fresh profile and seeds two contact wallets and RPC endpoints before measurement. It covers wallet selection, both modes, same-chain RPC switching, rich on/off, and wallet-required network acceptance/rejection. It measures empty-stack switching and rich-mode changes with one simulated transaction, injects an uncached RPC simulation failure, and verifies recovery. It also holds a wallet reply while opening a second popup and closing/reopening the initiating popup, checking shared pending status and disabled controls. These results do not predict real-wallet or large-stack performance.

Configure the fixture delays and sample count:

```bash
BENCH_RPC_DELAY_MS=150 BENCH_WALLET_DELAY_MS=300 BENCH_ITERATIONS=3 bun run benchmark:popup-switching
```

The defaults are shown above. `CHROME_BIN` selects the browser binary. Persistent profile variables are rejected because the benchmark seeds settings. No existing profile is modified.

The JSON report includes each sample and per-scenario minimum, median (upper middle for even counts), and maximum timings:

- `feedbackFrameMs`: first animation frame observing pending feedback, the selected value, or a new error.
- `persistedMs`: the setting's storage-change event, when one occurs; rejected switches do not have this field.
- `selectionFrameMs`: first frame showing the selected value. For rich mode this is the optimistic checkbox state, not completed balance refresh. Rejected switches omit this field.
- `replyMs`: completion of the real popup/background request, including wallet approval when required.
- `completedFrameMs`: first frame after the reply with pending feedback removed.
- `rpcRequests`: local fixture RPC requests completed during the sample; cache hits and empty-stack changes can require none.

The popup is brought to the foreground for frame sampling. These are animation-frame observations, not GPU paint timestamps. The benchmark fails for wrong outcomes, missing visual feedback or successful-setting persistence events, unsupported fixture RPC calls, wallet switches completing before the configured wallet delay, or rejected switches changing persisted RPC state. It imposes no machine-dependent speed threshold.

The transient RPC failure scenario expects the rich setting to be saved while the popup displays a failed simulation; an explicit refresh must recover once the fixture RPC is restored.

The wallet-response deadline is covered by focused tests using a shortened timeout; the browser fixture holds and releases replies explicitly rather than waiting two minutes. Timing samples cover ten scenarios; popup lifecycle/conflict and RPC-recovery assertions run alongside them without speed thresholds.

For comparisons, build each revision and run the same command with the same browser, delays, iteration count, and host load. Compare feedback and selected-value timings separately from total completion time. Fixture setup is excluded from sample timings.
