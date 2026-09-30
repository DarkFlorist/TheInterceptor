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

After a successful chain switch and return to simulation mode, the same connected page must report the new `eth_chainId` and `net_version`. This catches content ports retaining the service pair from startup.

The transient RPC failure scenario expects the rich setting to be saved while the popup displays a failed simulation; an explicit refresh must recover once the fixture RPC is restored.

The wallet-response deadline and a later dapp request on the same signer connection are covered by focused tests using a shortened timeout. Per-command IDs prevent expired or reordered wallet replies from completing another switch; the browser fixture holds and releases replies explicitly rather than waiting two minutes. Timing samples cover ten scenarios; popup lifecycle/conflict and RPC-recovery assertions run alongside them without speed thresholds.

For comparisons, build each revision and run the same command with the same browser, delays, iteration count, and host load. Compare feedback and selected-value timings separately from total completion time. Fixture setup is excluded from sample timings.

The communication check also registers an IPv6 Safe Apps host through real Chrome, corrupts the persisted hosting selection, verifies that base provider injection is restored and the registration error is recorded, then completes the ordinary approval flow.

## Request Finance Safe discovery

After `bun run setup-chrome`, run:

```bash
bun run test:chrome-request-finance-discovery
```

This scenario reuses the Safe co-signing harness with a test signer, a configured Safe, and a local RPC fixture. CDP serves a local HTML fixture at the Request Finance HTTPS origin so the extension injects its real Safe host shim. The page reproduces the SDK's parent-message checks and the site's 200 ms discovery race. The test explicitly opts into this origin, keeps the real access popup open for 11 seconds, and verifies that the site's own 200 ms discovery deadline fires unchanged. After approval, the Settings authorize-and-reload action prepares the connection; the reloaded page receives the expected address, chain, owner, and threshold with no repeated signer prompt. Its 200 ms discovery race may still time out during extension initialization; the fixture checks that a late SDK reply does not undo that outcome.

By default, the browser starts with a temporary profile. This check does not load the live Request Finance app or use a real wallet. `CHROME_BIN` selects the browser binary as described above.

## Safe Apps hosting on selected websites

Run `bun run test:chrome-safe-apps-host` after `bun run setup-chrome`. The existing Safe co-signing harness serves a bundled fixture containing Safe Apps SDK 9.1.0, Wagmi's Safe connector, and Web3-Onboard's Safe connector on HTTP and HTTPS origins. It checks real extension access approvals, the Settings “Authorize and reload open tab” action, independent authorization on the second origin, and isolation of unselected origins and ports. The signer and RPC are local test doubles.

In Settings, enable Safe Apps compatibility and add the website URL. Hosting applies to its exact HTTP(S) origin, including scheme and port; refresh an already open page to install or remove it. No websites are hosted by default; add Request Finance explicitly if needed. Select a Safe in signing mode, open the app, and authorize and reload its tab before connecting. Website access still requires the ordinary Interceptor approval.

The shared host supports parent-based SDK discovery and leaves every website timer and discovery deadline unchanged. Authorize the Safe and reload before connecting. Short probes such as Request Finance's 200 ms race can still time out after approval; preparation removes the interactive approval delay but does not guarantee a response within the site's deadline. Wagmi's default 10 ms deadline can be too short for extension communication, so the browser fixture uses its documented `unstable_getInfoTimeout` option with 5 seconds. Apps with such deadlines need connector configuration or a discovery change in the app. Web3-Onboard's stricter `self !== top` iframe check and trusted parent-origin requirements are intentionally preserved; a real iframe launcher is a separate extension of this design.
