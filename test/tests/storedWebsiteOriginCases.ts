// The cases that access policy, request blocking and content-script injection must all agree on: [stored origin, page origin, whether the record stands for the page].
export const storedWebsiteOriginCases: readonly (readonly [string, string, boolean])[] = [
	['https://example.test', 'https://example.test', true],
	['https://example.test', 'http://example.test', false],
	['https://example.test:8443', 'https://example.test', false],
	['example.test', 'https://example.test', true],
	['example.test', 'http://example.test', true],
	['example.test', 'https://app.example.test', false],
	['example.test:443', 'https://example.test', true],
	['example.test:443', 'http://example.test', false],
	['example.test:80', 'http://example.test', true],
	['example.test:80', 'https://example.test', false],
	['example.test:8080', 'http://example.test:8080', true],
	['example.test:8080', 'http://example.test', false],
	['', 'file:///tmp/dapp.html', true],
	['', 'https://example.test', false],
	['file:///tmp/dapp.html', 'file:///tmp/dapp.html', true],
	['file:///tmp/dapp.html', 'file:///tmp/other.html', false],
]
