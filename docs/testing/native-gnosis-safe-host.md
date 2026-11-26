# Native Gnosis Safe Apps host

- With a Gnosis Safe selected, choose **Open as Gnosis Safe App** in the Interceptor popup. The website opens in a real iframe inside an extension-owned page on Chrome MV3 and Firefox MV2.
- Keep the original website tab open. Requests rejoin that tab's existing wallet connection and background permission/approval pipeline, preserving the app's identity.
- The host accepts SDK requests only from its configured child window and app origin. The runtime relay requires the extension-owned host and checks the original tab's current origin on every request; the content bridge checks it again before forwarding to the provider.
- Native `parent`, `top`, referrer, message origins and timers are preserved. There is no parent/referrer emulation, callback-source timer matching, framing-header removal or dependence on `app.safe.global`.

```mermaid
sequenceDiagram
    participant App as Website in native iframe
    participant Host as Extension-owned host
    participant Relay as Background relay
    participant Source as Original website provider
    participant Core as Existing background RPC pipeline
    App->>Host: SDK request (native source and origin)
    Host->>Relay: Request bound to app origin and source tab
    Relay->>Source: Deliver to original top-level content bridge
    Source->>Core: Request using the app's website connection
    Core->>Core: Website permissions and normal approvals
    Core-->>Source: Result
    Source-->>Relay: SDK result
    Relay-->>Host: Result
    Host-->>App: Native postMessage reply
```

## Lifecycle and limits

- Public Gnosis Safe metadata is prepared before loading the iframe, refreshed periodically with a bounded cache lifetime; both intervals and the SDK-handshake warning deadline follow the [native host timing policy](../../app/ts/utils/nativeGnosisSafeAppsHostTiming.ts). Permission, account, mode, chain and meaningful Gnosis Safe configuration changes invalidate it. Routine website titles/icons and address metadata enrichment do not interrupt an app session.
- A temporary metadata refresh failure shows an error while preserving the existing iframe and unfinished app input; recovery does not reload it or extend the metadata cache lifetime.
- The popup sends an extension-only launch command. The background validates the current source URL, enables compatibility, and focuses an identical tracked host without navigation or opens another tab for a different launch, preserving existing app sessions.
- Context changes during a pending operation preserve its original frame for the terminal reply and block new requests until reconnection. Retry is disabled while operations remain pending. Transactions and signatures are never automatically replayed.
- Sites that block embedding, require a specific Gnosis Safe parent origin or depend on unavailable embedded login/storage behavior may be unsupported. A frame load event is not proof of connection; the host explains when no SDK handshake arrives.
- Closing the original tab or navigating it to another origin disconnects the app. Website-origin permission checks and normal approval dialogs remain authoritative.
- In simulation mode, transactions stay in the local stack. Off-chain Gnosis Safe message services are unavailable. HTTP read interception remains in the separate child PR; it is not part of this host architecture.

## Browser regression coverage

`bun run test:browser:native-hosting --browser=chrome` and the equivalent Firefox invocation run the same fixture. The shared `bun run test:browsers` matrix builds and tests both engines.

The native-host fixture passed on Chrome MV3 and Firefox MV2 in signing and simulation configurations:

- SDK metadata, chain and environment replies; real parent/source/origin relationships; unchanged timers and native referrer behavior.
- Origin mismatch rejection and permission revocation without reusing cached metadata.
- Temporary metadata failure and recovery preserve the exact iframe, generation and unfinished app input; both engines capture the error and recovered UI states.
- Two separately approved simulation transactions in one stack, attributed to the app origin, with no owner-wallet broadcast. Retry and repeated popup launches preserve the original frame while each approval is pending.
- Honest unsupported state for a fixture that rejects the extension parent, and preservation of actual CSP/X-Frame-Options framing restrictions.

These controlled tests do not establish compatibility with every live website or exercise real signing/broadcasting. Live-site results and the final project validation/review status are reported separately.

## UI screenshots

These are **synthetic local fixtures**, not live-site connection claims. The screenshots were captured directly from the browser without image editing; the screenshot-only mock RPC used a current block timestamp to avoid an unrelated stale-RPC warning.

![Selected Gnosis Safe and native-host launch action](screenshots/native-gnosis-safe-launcher-chrome.png)

![Extension-owned native host with a local SDK fixture](screenshots/native-gnosis-safe-host-chrome.png)

The refresh regression injects a transport failure and retains the same unfinished draft through recovery:

| Browser | Refresh error | Recovered |
| --- | --- | --- |
| Chrome MV3 | [Preserved draft](screenshots/native-gnosis-safe-refresh-chrome-error.png) | [Same draft after recovery](screenshots/native-gnosis-safe-refresh-chrome-recovered.png) |
| Firefox MV2 | [Preserved draft](screenshots/native-gnosis-safe-refresh-firefox-error.png) | [Same draft after recovery](screenshots/native-gnosis-safe-refresh-firefox-recovered.png) |

## Live-site observations (2026-11-25)

These read-only trials used a public Gnosis Safe and a wallet double that cannot sign or broadcast. “Connected” means the app UI showed that account, not merely that an SDK query succeeded. No live-site transaction was submitted. Native browser policy can differ between engines.

| Website | Chrome simulation / signing | Firefox simulation | Firefox signing |
| --- | --- | --- | --- |
| Aave | Connected | Connected | Connected |
| CoW | Browser blocks the frame | Connected | SDK replies; UI connection unconfirmed |
| Lido | Browser blocks the frame | SDK replies; UI connection unconfirmed after normal connection UI | SDK replies; UI connection unconfirmed after normal connection UI |
| Request Finance | Browser blocks the frame | Browser blocks the frame | Browser blocks the frame |
| Uniswap | Browser blocks the frame | Browser blocks the frame | Browser blocks the frame |
| 1inch | Browser blocks the frame | Browser blocks the frame | Browser blocks the frame |

The genuine-Gnosis-Safe-parent prototype had broader compatibility; those results do not apply to the chosen extension-owned host. The implementation leaves these policies intact instead of spoofing a trusted origin or stripping headers. Lack of an SDK handshake is reported as a possible framing/origin/SDK compatibility limit, not a definitive browser-policy diagnosis.

Final Chrome evidence is under `/tmp/native-host-final-chrome-live/chrome`; the earlier run under `/tmp/native-host-live/chrome` preceded the metadata-context fixes and is not the final connection result. Other local evidence and screenshots are under `/tmp/native-host-live/firefox`. Firefox main-world observation reruns are under `/tmp/native-host-verified-live/firefox`, with the normal Lido consent interaction under `/tmp/native-host-consent-live/firefox`. Earlier Firefox isolated-world telemetry could not observe the child reliably; those empty telemetry arrays are not connection failures. The [committed live summary](native-gnosis-safe-live-results.json) records observed outcomes without claiming universal support.

## Chrome iframe RPC timeout

The earlier 1inch investigation found a separate provider defect: approved iframe account/chain RPCs waited for cosmetic website metadata, which waited for the outer tab to finish loading. Metadata now uses an immediate tab snapshot without tab-load or favicon polling, and a different frame origin cannot inherit the outer tab’s title/icon. A causal Chrome cross-process-frame probe changed from hanging to returning the expected account and chain; the shared provider-injection regression covers it in both engines. This fixes the RPC stall; it does not bypass 1inch’s native framing restriction above.

Live Aave connection in a native extension-owned frame on Chrome (simulation configuration, no transaction submitted):

![Aave connected through the native extension host](screenshots/native-gnosis-safe-aave-chrome.png)


## Child HTTP simulation reads

The HTTP-interception child adds a separate, default-off **simulated website HTTP reads** setting. Enabling Gnosis Safe App hosting alone does not enable it. Existing backups preserve hosting and leave the new capability off; version 1.8 backups store both choices independently.

When enabled, approved Gnosis Safe simulation sessions receive supported JSON-RPC and vendor balance/status overlays on any HTTP(S) page. Each background read still checks the current account, chain and website grant. Signing, other-chain and unknown responses keep native network behavior. An explicitly disabled publication releases the native iframe's early network reads without an overlay.

The build privately composes the HTTP feature with the provider into one classic script for both browsers. The provider module has no vendor imports, and no page-global registration function can capture its internal RPC callback. This includes the feature code in the assembled provider artifact while allowing live preference changes and avoiding a public privileged registration channel.

Portfolio wire mapping delegates exact quantities, selected-chain value changes and group totals to a typed aggregation owner. Simulation logs and HTTP overlays derive native currency identity from one shared constant.

The settings scenario runs on both browsers through `bun run test:browsers`. These captures show the two independent controls; simulated website HTTP reads default to off:

| Chrome MV3 | Firefox MV2 |
| --- | --- |
| ![Independent hosting and HTTP settings in Chrome](screenshots/gnosis-safe-session-settings-chrome.png) | ![Independent hosting and HTTP settings in Firefox](screenshots/gnosis-safe-session-settings-firefox.png) |
