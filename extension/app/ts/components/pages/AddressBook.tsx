import { useEffect } from 'preact/hooks'

export function AddressBook() {

	useEffect( () => {
		function popupMessageListener(msg: unknown) {
			console.log('popup message')
			console.log(msg)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => {
			browser.runtime.onMessage.removeListener(popupMessageListener)
		};
	}, []);

	return (
		<main>
			<div class="columns" style = 'margin: 10px'>
				<div class="column is-2">
					<aside class="menu">
						<ul class="menu-list">
							Active Addresses
						</ul>
						<ul class="menu-list">
							Contacts
						</ul>
						<ul class="menu-list">
							Contracts
						</ul>
						<ul>
							<li><a>Tokens</a></li>
							<li><a>Non Fungible Tokens</a></li>
							<li><a>Other</a></li>
						</ul>
					</aside>
				</div>
				<div class="column">
					<p class="bd-notification is-primary">Second column with more content. This is so you can see the vertical alignment.</p>
				</div>
			</div>
		</main>
	)
}
