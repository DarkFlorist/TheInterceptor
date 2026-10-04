import * as assert from 'assert'
import { signal } from '@preact/signals'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { ChangeActiveAddress } from '../../app/ts/components/pages/ChangeActiveAddress.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	readonly childNodes?: readonly TestNode[]
	readonly dispatchEvent?: (event: { bubbles?: boolean, type: string }) => boolean
	readonly getAttribute?: (name: string) => string | null
	readonly tagName?: string
}

function collectButtons(node: TestNode | undefined, results: TestNode[] = []) {
	if (node?.tagName === 'BUTTON') results.push(node)
	for (const child of node?.childNodes ?? []) collectButtons(child, results)
	return results
}

function collectByRole(node: TestNode | undefined, role: string, results: TestNode[] = []) {
	if (node?.getAttribute?.('role') === role) results.push(node)
	for (const child of node?.childNodes ?? []) collectByRole(child, role, results)
	return results
}

describe('ChangeActiveAddress', () => {
	for (const hasSigner of [false, true]) test(`uses selectable rows without nesting interactive controls (${ hasSigner ? 'with' : 'without' } a signer)`, async () => {
		const dom = installDomMock()
		const activeAddress: AddressBookEntry = {
			type: 'contact',
			name: 'Test account',
			address: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			askForAddressAccess: true,
		}
		let selectedAddress: bigint | 'signer' | undefined
		try {
			await act(() => {
				render(<ChangeActiveAddress
					activeAddresses = { signal([activeAddress]) }
					addNewAddress = { () => undefined }
					close = { () => undefined }
					renameAddressCallBack = { () => undefined }
					setActiveAddressAndInformAboutIt = { address => { selectedAddress = address } }
					signerAccounts = { hasSigner ? [2n] : [] }
					signerName = 'NoSignerDetected'
				/>, dom.document.body)
			})

			const choiceButtons = collectButtons(dom.document.body).filter((button) => button.getAttribute?.('class')?.split(/\s+/).includes('interceptor-dialog-choice'))
			assert.equal(choiceButtons.length, hasSigner ? 2 : 1)
			for (const choice of choiceButtons) {
				const descendantButtons = (choice.childNodes ?? []).flatMap((child) => collectButtons(child))
				assert.equal(descendantButtons.length, 0)
				assert.equal(collectByRole(choice, 'img').length, 0)
			}

			choiceButtons.at(-1)?.dispatchEvent?.({ type: 'click', bubbles: true })
			assert.equal(selectedAddress, activeAddress.address)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
