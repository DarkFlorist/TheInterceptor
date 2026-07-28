import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { createLazyPage } from '../../app/ts/components/PopupModal.js'
import { ErrorBoundary } from '../../app/ts/components/subcomponents/Error.js'
import { installDomMock } from './domMock.js'

async function settleLazyPage() {
	await Promise.resolve()
	await Promise.resolve()
	await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('lazy popup pages', () => {
	test('renders a page after its module loads', async () => {
		const dom = installDomMock()
		const LazyPage = createLazyPage(
			async () => ({ TestPage: ({ label }: { label: string }) => <p>{ label }</p> }),
			'TestPage',
		)
		try {
			await act(() => {
				render(<LazyPage label = 'Loaded popup page' />, dom.document.body)
			})
			await act(settleLazyPage)
			assert.equal(dom.document.body.textContent, 'Loaded popup page')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('reports module load failures through the existing error boundary', async () => {
		const dom = installDomMock()
		const loadError = new Error('Popup page chunk failed to load')
		const LazyPage = createLazyPage<{ label: string }, 'TestPage'>(
			async () => await Promise.reject(loadError),
			'TestPage',
		)
		let caughtError: Error | undefined
		const originalConsoleError = console.error
		console.error = () => undefined
		try {
			await act(() => {
				render(
					<ErrorBoundary onError = { (error) => { caughtError = error } }>
						<LazyPage label = 'unused' />
					</ErrorBoundary>,
					dom.document.body,
				)
			})
			await act(settleLazyPage)
			assert.equal(caughtError, loadError)
		} finally {
			console.error = originalConsoleError
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
