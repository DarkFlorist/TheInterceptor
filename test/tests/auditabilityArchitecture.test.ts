import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as simulationFacade from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import * as simulationPersonalSigning from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import * as simulationTransactionSigning from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { getPopupMessageDomain, isPopupMessageMethod, popupMessageProtocol } from '../../app/ts/types/popupMessageProtocol.js'

const popupHandlerRegistrySources = [
	Bun.file(new URL('../../app/ts/background/popupMessageDispatcher.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/addressBook.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/settings.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/websiteAccess.ts', import.meta.url)),
	Bun.file(new URL('../../app/ts/background/popupMessageHandlerRegistries/safe.ts', import.meta.url)),
]

const getDeclaredPopupHandlerMethods = async (source: Bun.BunFile) => {
	const contents = await source.text()
	return Array.from(contents.matchAll(/^\s*(popup_[A-Za-z0-9_]+):/gmu), (match) => match[1]).filter((method) => method !== undefined)
}

test('simulation service keeps compatibility exports backed by focused signing modules', () => {
	assert.equal(simulationFacade.mockSignTransaction, simulationTransactionSigning.mockSignTransaction)
	assert.equal(simulationFacade.getSignedTransactionForSimulation, simulationTransactionSigning.getSignedTransactionForSimulation)
	assert.equal(simulationFacade.getMessageHashForPersonalSign, simulationPersonalSigning.getMessageHashForPersonalSign)
	assert.equal(simulationFacade.simulatePersonalSign, simulationPersonalSigning.simulatePersonalSign)
})

test('popup handler registries agree with the protocol domain inventory', () => {
	const expectedRegistryDomains = [
		{ source: popupHandlerRegistrySources[1], domains: new Set(['address-book', 'navigation']) },
		{ source: popupHandlerRegistrySources[2], domains: new Set(['settings', 'navigation']) },
		{ source: popupHandlerRegistrySources[3], domains: new Set(['website-access', 'navigation']) },
		{ source: popupHandlerRegistrySources[4], domains: new Set(['safe']) },
	]
	return Promise.all(expectedRegistryDomains.map(async ({ source, domains }) => {
		if (source === undefined) throw new Error('Popup handler registry source is missing')
		const methods = await getDeclaredPopupHandlerMethods(source)
		assert.notEqual(methods.length, 0)
		for (const method of methods) {
			assert.equal(isPopupMessageMethod(method), true, `${ method } is missing from the popup protocol`)
			if (!isPopupMessageMethod(method)) continue
			assert.equal(domains.has(getPopupMessageDomain(method)), true, `${ method } is assigned to the wrong domain`)
		}
	}))
})

test('each popup method has exactly one handler owner', async () => {
	const declaredMethods = (await Promise.all(popupHandlerRegistrySources.map(getDeclaredPopupHandlerMethods))).flat()
	const duplicateMethods = declaredMethods.filter((method, index) => declaredMethods.indexOf(method) !== index)
	assert.deepEqual(duplicateMethods, [])
	assert.equal(new Set(declaredMethods).size, Object.keys(popupMessageProtocol).length)
	for (const method of Object.keys(popupMessageProtocol)) assert.equal(declaredMethods.includes(method), true, `${ method } has no handler owner`)
})

test('historical popup wire spellings are explicit protocol exceptions', () => {
	assert.equal(popupMessageProtocol.popup_ChangeSettings.legacyWireName, true)
	assert.equal(popupMessageProtocol.popup_import_settings.legacyWireName, true)
	assert.equal(popupMessageProtocol.popup_UnexpectedErrorOccured.legacyWireName, true)
	assert.equal('legacyWireName' in popupMessageProtocol.popup_confirmDialog, false)
})

test('popup method guards reject inherited object keys', () => {
	assert.equal(isPopupMessageMethod('toString'), false)
	assert.equal(isPopupMessageMethod('__proto__'), false)
})
