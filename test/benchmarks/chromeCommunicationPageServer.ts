import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

export type ChromeCommunicationPageServer = {
	baseUrl: string
	close: () => Promise<void>
}

export async function startChromeCommunicationPageServer(): Promise<ChromeCommunicationPageServer> {
	const html = await readFile(
		new URL('./chromeCommunicationPage.html', import.meta.url),
		'utf8',
	)
	const server = createServer((request, response) => {
		if (request.url === '/favicon.ico') {
			response.writeHead(204, { 'Cache-Control': 'no-store' })
			response.end()
			return
		}

		response.writeHead(200, {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		})
		response.end(html)
	})

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})

	const address = server.address()
	if (address === null || typeof address === 'string')
		throw new Error('Could not start the Chrome communication test page server')

	return {
		baseUrl: `http://127.0.0.1:${address.port}/`,
		close: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => resolve())
			}).catch(() => undefined)
		},
	}
}
