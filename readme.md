<img src = "extension/app/img/LOGOA_400x400.png" alt = "The cutest dino" style = "width: 200px;"/>

# The Interceptor Alpha
The Interceptor is a browser extension that explains what kind of Ethereum transactions you are making. Interceptor works with Metamask or without Metamask. If Metamask is installed, you can send transactions with The Interceptor by forwarding the transactions for Metamask for signing. But where The Interceptor really thrives, is Simulation Mode. the mode enables you to simulate multiple transactions and see what they do, you can even use DApps in simulation for free! We currently Support Chrome, Firefox and Brave. What comes to networks, we are supporting Ethereum Mainnet and Görli.

![Example](/transaction_outcome.png)

# Privacy
We value your privacy highly. The Interceptor is designed to minimize privacy leakage: We don't query external sites for anything. However, The Interceptor Alpha is currently connecting to Ethereum RPC nodes operated by Dark Florists (us) because we utilize some custom tooling on the backend. Work is underway to get our custom tooling standardized across clients so Interceptor will work with any standards compliant Ethereum client.

# Installation
Download [The Interceptor](https://github.com/DarkFlorist/TheInterceptor/releases/latest) and depending on your browser:

- Chrome: Unzip The Interceptor zip to a folder, browse to `chrome://extensions/` and click `Load unpacked` and select the folder.
- Firefox: Browse to `about:debugging` and click `Load Temporary Add-on` and select the zip. You need to re-add the extension every time you restart Firefox.
- Brave: Unzip The Interceptor zip to a folder, browse to `brave://extensions/` and click `Load unpacked` and select the folder.

Next you should click your extensions from the top right corner and pin it for easy access! If you have some DApps already open, refresh the page to get The Interceptor injected. You are now good to go and ready to intercept!

Some good DApps to try first are [Uniswap](https://1-104-1.uniswap-uncensored.eth.limo/#/swap) and [nftx.io](https://nftx.io/)!

# Development

## Setup

Browse to the `/extension` folder and then:

Install:
`npm ci --ignore-scripts`

Build:
`npm run vendor && npm run build`

Then depending on your browser:
- Chrome: Browse to `chrome://extensions/` and click `Load unpacked` and point to `\extension\app\manifest.json`.
- Firefox: Browse to `about:debugging` and click `Load Temporary Add-on` and point to `\extension\app\manifest.json`.
- Brave: Browse to `brave://extensions/` and click `Load unpacked` and point to `\extension\app\manifest.json`.

# Contact Us!
You can reach us via [Discord](https://discord.gg/b66SwRZAbu) and twitter [@DarkFlorist](https://twitter.com/DarkFlorist)!
