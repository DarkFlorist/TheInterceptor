# Gnosis Safe live Firefox checks

> Historical prototype observations: these checks predate the extension-owned iframe architecture. See [the current native host design and limitations](native-gnosis-safe-host.md); production code does not emulate parent, referrer or timers.

Tested 2026-11-24 with Firefox 153.7.0 (MV2), fresh isolated profiles, Gnosis Safe Apps compatibility enabled, and public Ethereum Gnosis Safe addresses. This report covers the stacked hosting and RPC-interception branches (#1616 and #1791 together).

| Website | Simulation mode | Signing mode | Scope / observed restrictions |
| --- | --- | --- | --- |
| [Aave](https://app.aave.com) | Connected; approved and supplied 0.000001 USDS locally | Connected; token approval reached Gnosis Safe EIP-712 review, then rejected | Simulated approval enabled Supply; site showed “Supplied Successfully”, USDS decreased from 0.0077524 to 0.0077514; persisted on reload |
| [CoW](https://swap.cow.fi) | Connected automatically as Safe App | Connected automatically as Safe App | Follow-up fixed parent-origin recognition and cold discovery; no manual reload; order execution not tested |
| [Lido](https://stake.lido.fi) | Connected; staked 0.01 ether locally | Connected; 0.00001 ether stake reached Gnosis Safe EIP-712 review, then rejected | Accepted Lido's own connection confirmation; simulation showed success, ether decreased and stETH increased; persisted on reload |
| [Request Finance](https://app.request.finance) | Correct Gnosis Safe SDK metadata | Correct Gnosis Safe SDK metadata | Authentication screen prevents checking logged-in workflows |
| [Uniswap](https://app.uniswap.org) | Selected Gnosis Safe connected | Selected Gnosis Safe connected | Ordinary Interceptor provider; no Gnosis Safe SDK discovery observed; swaps not executed |
| [1inch](https://1inch.com/swap) | Selected Gnosis Safe connected | Selected Gnosis Safe connected | Chose “The Interceptor Detected” from website wallet picker; swaps not executed |

No real signatures or broadcasts were performed. The test owner provider only answered account/chain requests and rejected signing or sending. Signing results establish routing to review and rejection, not completed owner signatures or on-chain execution. Direct public-RPC checks before/after showed unchanged real balances, allowance and nonce for the simulated Aave flow, and unchanged ether/stETH balances and nonce for Lido.

## Reproduction

- Build with `bun run setup-firefox` and load the extension into a fresh Firefox profile.
- Add an Ethereum Gnosis Safe address, enable Gnosis Safe Apps compatibility, select that address in simulation mode, and approve the website. Reload after changing hosting eligibility.
- For signing mode, connect an owner wallet and select its Gnosis Safe. Use public read-only owner doubles only when testing discovery/review; reject transaction requests before signing.
- Visit each URL above. Complete site-owned connection consent or choose Interceptor in ordinary wallet pickers when required.
- In simulation mode, enable the local ether balance override for Lido, stake 0.01 ether, and approve “Simulate Swap!”. Check successful staking and balances after reload.
- For Aave, use a Gnosis Safe with USDS, supply 0.000001 USDS, approve the token and supply in the local simulation. Check the site advances after approval and shows the decreased USDS balance after reload.

## Regressions fixed

- Firefox's integer-rounded frame clocks could put the discovery message timestamp just before its candidate timer. The shared discovery matcher allows two milliseconds only when all relevant clocks are integer-rounded; fractional clocks retain the tighter allowance. Shared Lido fixtures exercise both browsers under delayed RPC and short SDK deadlines.
- Firefox structured cloning preserves optional `safeTxGas: undefined` in SDK messages, while Chrome JSON messaging drops it. Known optional transaction fields are normalized before strict schema validation, with unknown or malformed fields still rejected. Shared browser and unit checks cover this shape.

The live artifacts (screenshots, SDK traces and before/after JSON) were captured under `/tmp/pr1616-firefox-live`, `/tmp/pr1616-firefox-live-actions`, and `/tmp/pr1616-firefox-flows` in the test workspace. They are session evidence, not committed fixtures. Deterministic regression coverage lives in the shared [browser scenario registry](../../scripts/test-browsers.mts); run `bun run test:browsers` for both engines.

## CoW cold-start follow-up

CoW checks the apparent parent origin before selecting its Gnosis Safe connector, then gives SDK metadata discovery one second. The approved host now exposes the synthetic Gnosis Safe parent through the shared `document.referrer` fallback and SDK reply origin. It restores the original referrer on disposal; native page origin, frame-source validation and messaging stay intact. Settings and console messages disclose this local emulation.

The current bounded bootstrap and deadline policy is documented in [the shared browser harness guide](../../test/benchmarks/README.md#short-gnosis-safe-discovery-deadlines). The follow-up covers lazy SDK initialization before a request is posted, alongside clock rounding, concurrent probes, origin isolation and cleanup. This remains shared across eligible websites rather than a hostname exception.

Live follow-up used three fresh profiles per mode per browser, plus one first-navigation case per mode per browser with CoW's already-observed boot feature flags initialized. Every successful account panel identified **Connected with Safe App**. No test requested a manual reload. Completely fresh CoW site storage still triggers CoW's own automatic feature-flag restart; the isolated first-navigation cases verify the connector without that unrelated restart. Test setup waits for Chrome's asynchronous host registration before navigation; changing eligibility on an already-open page retains the documented hosting reload requirement.

Follow-up artifacts: `/tmp/pr1616-cow-cold-firefox`, `/tmp/pr1616-cow-cold-chrome`, and their `-remembered-site` counterparts. These contain screenshots, SDK replies, navigation histories and account-panel text. No orders, signatures or broadcasts were submitted.

## Shared hosting compatibility

Parent metadata, synthetic SDK reply origins and bounded discovery handling now use one policy for every eligible HTTP(S) website; there is no CoW/Lido allowlist in the hosting implementation. Website approval, selected Gnosis Safe and the compatibility setting still control injection. The JavaScript referrer is emulated; browser HTTP referrer headers and native page origins are unchanged. Tests cover unrelated HTTPS domains, custom ports and HTTP localhost, including a shared browser fixture with 10 ms discovery and delayed metadata. Named-site cases remain regression fixtures rather than product rules. This generalization is fixture-tested; the live results above describe the earlier site-specific run. Real iframe requirements, trusted native events or other connector protocols can still require separate support. HTTP RPC interception remains separate from hosting.
