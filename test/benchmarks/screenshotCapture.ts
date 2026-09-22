import type { CdpConnection } from './chromeHarness.js'

/** Capture the actual toolbar viewport, or a full page without resizing its layout height. */
export async function captureExtensionScreenshot(page: CdpConnection, path: string, surface: 'popup' | 'page') {
	await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 })
	const deadline = Date.now() + 15000
	while (await page.evaluate<boolean>(`document.readyState !== 'complete' || document.querySelector('[aria-busy="true"]') !== null`)) {
		if (Date.now() > deadline) throw new Error(`Screenshot is still loading: ${path}`)
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	const diagnostics = await page.evaluate<{ width: number; height: number; dpr: number; fonts: string[]; images: number }>(`(async () => {
		const loaded = await Promise.all([document.fonts.load('400 16px Inter'), document.fonts.load('600 16px Inter'), document.fonts.load('400 16px Atkinson')]);
		if (loaded.some(faces => faces.length === 0)) throw new Error('Required bundled font is not declared');
		await document.fonts.ready;
		for (const font of ['Inter', 'Atkinson']) if (!document.fonts.check('16px ' + font)) throw new Error('Missing font: ' + font);
		const images = [...document.images].filter(image => image.getClientRects().length > 0);
		for (const image of images) { if (image.complete && image.naturalWidth === 0) throw new Error('Missing icon: ' + image.src); await image.decode(); }
		for (const link of document.querySelectorAll('link[rel="stylesheet"]')) if (!link.sheet) throw new Error('Missing stylesheet: ' + link.href);
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		if (document.documentElement.scrollWidth > innerWidth) throw new Error('Horizontal overflow in screenshot');
		return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, fonts: [...document.fonts].filter(font => font.status === 'loaded').map(font => font.family), images: images.length };
	})()`)
	if (surface === 'popup' && (diagnostics.width !== 520 || diagnostics.height !== 600))
		throw new Error(`Unexpected toolbar popup viewport: ${JSON.stringify(diagnostics)}`)
	await page.send('DOM.enable')
	await page.send('CSS.enable')
	const document = await page.send<{ root: { nodeId: number } }>('DOM.getDocument')
	const textNode = await page.send<{ nodeId: number }>('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'h1, .signing-wallet-summary p' })
	if (textNode.nodeId === 0) throw new Error('Missing representative text for font verification')
	const renderedFonts = await page.send<{ fonts: { familyName: string; isCustomFont: boolean; glyphCount: number }[] }>('CSS.getPlatformFontsForNode', {
		nodeId: textNode.nodeId
	})
	// InterVariable.woff2 is registered as CSS family Inter, with internal family Inter Variable.
	if (!renderedFonts.fonts.some((font) => font.familyName === 'Inter Variable' && font.isCustomFont && font.glyphCount > 0))
		throw new Error(`Screenshot text fell back from bundled Inter: ${ JSON.stringify(renderedFonts) }`)
	const metrics = await page.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics')
	const clip = { x: 0, y: 0, width: diagnostics.width, height: surface === 'popup' ? diagnostics.height : metrics.cssContentSize.height, scale: 1 }
	const result = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: surface === 'page', clip })
	await Bun.write(path, Buffer.from(result.data, 'base64'))
	console.info(JSON.stringify({ screenshot: path.split('/').pop(), surface, ...diagnostics, renderedFonts: renderedFonts.fonts, captureHeight: clip.height }))
}
