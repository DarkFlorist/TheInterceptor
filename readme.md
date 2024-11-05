<img src = "app/img/LOGOA_400x400.png" alt = "The cutest dino" style = "width: 200px;"/>

# The Interceptor Alpha
Introducing The Interceptor - the ultimate browser extension for Ethereum! Say goodbye to the confusion of making transactions with our intuitive tool that provides clear explanations of the type of Ethereum transactions you're making. The Interceptor can be used alongside with Metamask or as a standalone transaction simulation tool. With Metamask integration, you can easily send transactions by forwarding them for signing. But what really sets The Interceptor apart is its Simulation Mode. This powerful feature allows you to simulate multiple transactions and see exactly what they will do - even using DApps for free! Our extension is currently available on Chrome, Firefox, and Brave, and supports Ethereum Mainnet, Sepolia and Görli networks. Experience seamless Ethereum transactions like never before with The Interceptor.

Install for [Firefox](https://github.com/DarkFlorist/TheInterceptor/releases/download/v0.0.25/TheInterceptor-firefox-v0.0.25.xpi) or [Chrome](https://www.dark.florist/google-chrome-install)

# Features
- Simulation mode, send transactions for free and see what they do
- Impersonation mode, be Vitalik or anyone else and see the dApps with the eyes of anyone
- Rich mode, browse dapps with extra 200 000 ETH in your pocket!
- Simulate your transactions before sending them to be sure on what they do
- Avoid common token pitfalls such as sending tokens to tokens contract address
- And more!

You can also watch [Interceptor introduction video](https://www.youtube.com/watch?v=Noxik2pZWV4) from Youtube to see The Interceptor in action!

<img src = "transaction_outcome.png" alt = "The cutest dino" style = "width: 400px;"/>
<img src = "popup_view.png" alt = "The cutest dino" style = "width: 300px;"/>

# Privacy
Your privacy is our priority. The Interceptor is purpose-built to minimize data leakage: no external queries are made without direct user input. By default, it connects to Ethereum RPC nodes operated by [Dark Florists (us)](https://www.dark.florist/), though you can configure it to connect to other RPC nodes if desired. Please note, The Interceptor requires RPC nodes that support the mandatory `eth_simulateV1` endpoint, currently available in Geth and Nethermind.

# Development

## Setup

Install:
`npm ci --ignore-scripts`

Build:
`npm run setup-chrome` for Chrome or `npm run setup-firefox` for firefox

Then depending on your browser:
- Chrome: Browse to `chrome://extensions/` and click `Load unpacked` and point to `\app\manifest.json`.
- Firefox: Browse to `about:debugging` and click `Load Temporary Add-on` and point to `\app\manifest.json`.
- Brave: Browse to `brave://extensions/` and click `Load unpacked` and point to `\app\manifest.json`.

# Contact Us!
You can reach us [Dark Florsts](https://www.dark.florist/) via [Discord](https://discord.gg/b66SwRZAbu) and twitter [@DarkFlorist](https://twitter.com/DarkFlorist)!
