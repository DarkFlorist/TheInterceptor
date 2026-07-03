import * as assert from 'assert'
import { describe, test } from 'bun:test'

function expectRule(css: string, selector: string) {
	const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = new RegExp(`${ escapedSelector }\\s*\\{([\\s\\S]*?)\\}`).exec(css)
	if (match?.[1] === undefined) throw new Error(`Missing CSS rule for ${ selector }`)
	return match[1]
}

describe('narrow text layout CSS', () => {
	test('keeps checkbox labels and dropdown text constrained inside narrow containers', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()

		const formControl = expectRule(css, '.form-control')
		assert.match(formControl, /grid-template-columns\s*:\s*1em minmax\(0,\s*1fr\)\s*;/)
		assert.match(formControl, /min-width\s*:\s*0\s*;/)
		assert.match(formControl, /max-width\s*:\s*100%\s*;/)

		const checkboxText = expectRule(css, '.form-control .checkbox-text')
		assert.match(checkboxText, /overflow-wrap\s*:\s*anywhere\s*;/)

		const dropdownText = expectRule(css, '.dropdown button > .truncate')
		assert.match(dropdownText, /min-width\s*:\s*0\s*;/)
		assert.match(dropdownText, /max-width\s*:\s*100%\s*;/)

		const chainSelector = expectRule(css, '.chainSelector')
		assert.match(chainSelector, /min-width\s*:\s*0\s*;/)
		assert.match(chainSelector, /max-width\s*:\s*100%\s*;/)
		assert.match(chainSelector, /overflow\s*:\s*hidden\s*;/)

		const grid = expectRule(css, ':where(.grid)')
		assert.match(grid, /min-width\s*:\s*0\s*;/)
		assert.match(grid, /max-width\s*:\s*100%\s*;/)

		assert.match(css, /\.card-header-title\s*\{[\s\S]*?min-width\s*:\s*0\s*;[\s\S]*?\}/)
		assert.match(css, /\.card-header-title\s*\{[\s\S]*?overflow\s*:\s*hidden\s*;[\s\S]*?\}/)
		assert.match(css, /\.card-header-title\s*\{[\s\S]*?text-overflow\s*:\s*ellipsis\s*;[\s\S]*?\}/)

		const cardHeaderWebsite = expectRule(css, '.card-header-website')
		assert.match(cardHeaderWebsite, /flex\s*:\s*0 1 16rem\s*;/)
		assert.match(cardHeaderWebsite, /min-width\s*:\s*0\s*;/)
		assert.match(cardHeaderWebsite, /max-width\s*:\s*100%\s*;/)

		const websiteOriginText = expectRule(css, '.website-origin-text')
		assert.match(websiteOriginText, /display\s*:\s*flex\s*;/)
		assert.match(websiteOriginText, /min-width\s*:\s*0\s*;/)
		assert.match(websiteOriginText, /max-width\s*:\s*100%\s*;/)

		const stackRowLinkHeader = expectRule(css, '.stack-row-link-header')
		assert.match(stackRowLinkHeader, /cursor\s*:\s*pointer\s*;/)
		assert.match(stackRowLinkHeader, /transition\s*:/)

		const simulationStackRow = expectRule(css, '.simulation-stack-row')
		assert.match(simulationStackRow, /scroll-margin-block\s*:\s*2rem\s*;/)

		const highlightedSimulationStackRow = expectRule(css, '.simulation-stack-row--highlighted')
		assert.match(highlightedSimulationStackRow, /animation\s*:\s*simulation-stack-row-target-pulse 1800ms ease-out\s*;/)
		assert.match(css, /@keyframes simulation-stack-row-target-pulse/)
	})

	test('uses flexible button height and stacks address book card actions at ultra-narrow widths', async () => {
		const css = await Bun.file('app/css/interceptor.css').text()

		const button = expectRule(css, ':where(.btn)')
		assert.match(button, /box-sizing\s*:\s*border-box\s*;/)
		assert.match(button, /height\s*:\s*auto\s*;/)
		assert.match(button, /min-height\s*:\s*2\.25em\s*;/)
		assert.match(button, /line-height\s*:\s*1\.2\s*;/)

		assert.match(css, /@media screen and \(max-width:\s*220px\)\s*\{[\s\S]*?\.address-book-entry-media\s*\{[\s\S]*?flex-direction\s*:\s*column\s*;/)
		assert.match(css, /@media screen and \(max-width:\s*220px\)\s*\{[\s\S]*?\.address-book-entry-actions\s*\{[\s\S]*?flex-direction\s*:\s*row\s*;/)
	})
})
