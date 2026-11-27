# Gnosis Safe simulation transaction stacks

Historical results for the former emulated host. They do not establish compatibility with the new extension-owned iframe; see the [current native-host results and restrictions](native-gnosis-safe-host.md#live-site-observations-2026-11-25).

Live checks on 2026-11-24 used Chrome 156 (MV3) and Firefox 153.7 (MV2), fresh isolated profiles, and the stacked hosting/RPC branches (#1616 and #1791 together). Transactions originated in each website's UI and were accepted through Interceptor's simulation review. Test setup selected public Ethereum Gnosis Safe accounts and enabled the local ether balance override; it did not insert transactions into the stack.

| Website | Transactions tested per browser | Result |
| --- | --- | --- |
| Lido | Stake 0.01 then 0.02 ether | Two transactions; cumulative ether/stETH balances survive reload |
| Aave | Approve USDS, supply 0.000001 then 0.000002 USDS | Three transactions; supplies succeed and reduced USDS balance survives reload |
| CoW | Wrap 0.00001 then 0.00002 ether | Two transactions; pending state clears |
| Uniswap | Wrap 0.00001 then 0.00002 ether | Two transactions; both show Wrapped and pending state clears through the receipt adapter |
| 1inch | Wrap 0.00001 then 0.00002 ether | Two transactions; balance adapter removes the insufficient-balance blocker and the UI reports execution |
| Request Finance | Open authenticated transaction UI | Blocked by login in both browsers; no transactions tested |

Standard same-chain JSON-RPC reads now work on every approved Gnosis Safe simulation host without adding website entries. Hosted startup reads wait up to one second for the first background context, reducing early live-read cache races while simulation context arrives. Signing and revoked sessions retain native transport. Aave's chain-routed proxy, 1inch's decimal balance/allowance API, and Uniswap's classic swap status API have explicit wire adapters because they are not standard JSON-RPC.

One earlier fresh Firefox CoW attempt timed out during discovery; the final fresh-profile rerun connected and completed both wraps. These passes do not establish that all cold-start timeouts are eliminated.

The original run left Uniswap's indexed token portfolio on live-chain holdings; the follow-up below adds the balance adapter. Transaction history, pools and earn positions remain supplied by Uniswap. Cross-chain bridging, user-operation settlement, authenticated Request Finance actions and real transaction execution were not tested. A changed confirmation review requires a second confirmation and now explains the reason visibly; stale approval is never accepted automatically.

No real signatures or broadcasts were performed. The owner provider answered only account/chain requests and refused signing and sending. Direct public-RPC snapshots checked real ether/token balances, account transaction counts and Gnosis Safe nonces before and after the tests.

To reproduce, build the extension for each browser, select a Gnosis Safe in simulation mode, enable Gnosis Safe Apps compatibility, approve the site, and follow the actions above. Verify the stack grows after each confirmation, check the website's settlement state, then reload Aave/Lido to check cumulative balances. The shared deterministic suite is `bun run test:browsers`; its scenarios are defined once in `scripts/test-browsers.mts` and run on both engines. Live JSON, screenshots and stack snapshots are session artifacts under `/tmp/pr1616-ui-fixes-retest`.


## Indexed portfolio and cold SDK initialization follow-up

Uniswap's flat token balances, multichain groups and wallet summary now use simulation quantities for the selected account and chain. Tokens received only in the simulation are added with public token metadata and available market quotes. Exact raw quantities are retained; hidden holdings and unrelated chains are preserved. Live one-day position changes are omitted instead of attaching their old values to simulated holdings.

Six follow-up fresh Firefox profiles (three signing, three simulation) connected in 3.6–5.0 seconds with no timeout errors. The Firefox CoW timeout occurred before `getSafeInfo` was posted: the one-second connector deadline expired during lazy SDK initialization. The shared host now covers that initial interval with bounded bootstrap grace. The [deadline policy and tradeoff](../../test/benchmarks/README.md#short-gnosis-safe-discovery-deadlines) apply to every eligible website; there is no Firefox/CoW hostname exception. The deterministic paired fixture waits 1.5 seconds before posting inside a one-second deadline, and checks concurrent discovery, CSP, both modes and both browsers.

Both browsers completed those two wraps and showed 199,999.97 ETH and 0.030 WETH on the full Portfolio page after its asynchronous refresh. Read-only public-chain snapshots remained unchanged.

Follow-up live evidence is recorded under `/tmp/pr1616-indexed-discovery-retest`. Uniswap tests submit 0.01 and 0.02 ether wraps from its UI, reload, then inspect the cumulative swap balances and Portfolio page. Gateway chain-identification failures are no longer cached for 30 seconds during session authorization; later reads retry identification instead of remaining on live data. CoW cold-start checks use fresh isolated profiles and read-only owner providers in signing mode; no real signing or broadcasting is possible.

Screenshots of the local simulation: [Chrome portfolio](screenshots/gnosis-safe-uniswap-portfolio-chrome.png), [Firefox portfolio](screenshots/gnosis-safe-uniswap-portfolio-firefox.png).
