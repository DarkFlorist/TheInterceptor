export function GnosisSafeAppsHostingSettings() {
	return <div class = 'grid' style = '--gap-y: 0.5rem; padding-block: 0.5rem'>
		<p class = 'paragraph'>With a Gnosis Safe selected, choose “Open as Gnosis Safe App” in the Interceptor popup. The app opens in a real iframe inside an extension page, in signing or simulation mode. Keep its original website tab open for the wallet connection and normal website permissions and approvals.</p>
		<p class = 'paragraph'>Websites that block embedding or accept only specific Gnosis Safe parent origins are unsupported. Interceptor preserves native browser framing, referrers, message origins and timers. It does not remove website framing protections or depend on the Gnosis Safe website to host apps.</p>
		<p class = 'paragraph'>In simulation mode, transactions and on-chain message approvals stay in your local simulation. Off-chain Gnosis Safe message services are unavailable.</p>
	</div>
}
