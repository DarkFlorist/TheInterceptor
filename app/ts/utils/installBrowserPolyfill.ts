import browserPolyfill from 'webextension-polyfill'

if (globalThis.browser === undefined) {
	globalThis.browser = browserPolyfill
}
