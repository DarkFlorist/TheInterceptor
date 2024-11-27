import { searchWebsiteAccess } from '../../app/ts/background/websiteAccessSearch.js'
import { WebsiteAccessArray, WebsiteAccess, Website, WebsiteAddressAccess } from '../../app/ts/types/websiteAccessTypes.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { run, runIfRoot, should } from '../micro-should.js'

export async function main() {
    // Helper function to create test data
    const createWebsiteAccess = ( title: string | undefined, origin: string, addresses: string[] = []): WebsiteAccess => ({
        website: { title, websiteOrigin: origin, icon: undefined } as Website,
        addressAccess: addresses.length ? addresses.map(addr => ({ address: BigInt(addr), access: true } as WebsiteAddressAccess)) : undefined
    })

    const testData: WebsiteAccessArray = [
        createWebsiteAccess('Ethereum Foundation', 'ethereum.org', ['0x123', '0x456']),
        createWebsiteAccess('Uniswap', 'app.uniswap.org', ['0x789']),
        createWebsiteAccess(undefined, 'etherscan.io', ['0xabc']),
        createWebsiteAccess('OpenSea', 'opensea.io', []),
    ]

    should('searchWebsiteAccess return all entries when query is empty', () => {
        const result = searchWebsiteAccess('', testData)
        return result === testData
    })

    should('searchWebsiteAccess match by title', () => {
        const result = searchWebsiteAccess('ethereum', testData)
        return result[0] === testData[0] // Ethereum Foundation should be first
    })

    should('searchWebsiteAccess match by origin', () => {
        const result = searchWebsiteAccess('uniswap', testData)
        return result[0] === testData[1] // Uniswap should be first
    })

    should('searchWebsiteAccess match by address', () => {
        const result = searchWebsiteAccess('0x123', testData)
        return result[0] === testData[0] // Entry with 0x123 should be first
    })

    should('searchWebsiteAccess rank results by Levenshtein distance', () => {
        const result = searchWebsiteAccess('etherscan', testData)
        // etherscan.io should be first (exact match)
        return result[0] === testData[2] && result[1] === testData[0]
    })

    should('searchWebsiteAccess handle case-insensitive search', () => {
        const result = searchWebsiteAccess('ETHEREUM', testData)
        return result[0] === testData[0]
    })

    should('searchWebsiteAccess handle undefined title', () => {
        const result = searchWebsiteAccess('etherscan', testData)
        return result[0] === testData[2]
    })

    should('searchWebsiteAccess handle non-sequential character matches', () => {
        const result = searchWebsiteAccess('usp', testData)
        return result.some(x => x.website.websiteOrigin === 'https://uniswap.org')
    })

    should('searchWebsiteAccess handle case insensitive matches', () => {
        const result = searchWebsiteAccess('UNISWAP', testData)
        return result.some(x => x.website.websiteOrigin === 'https://uniswap.org')
    })

    should('searchWebsiteAccess handle partial address matches', () => {
        const result = searchWebsiteAccess('0x1234', testData)
        return result.some(x => x.addressAccess?.some(addr => addressString(addr.address).toLowerCase().includes('0x1234')))
    })

    should('searchWebsiteAccess handle whitespace only query', () => {
        const result = searchWebsiteAccess('   ', testData)
        return result.length === testData.length
    })

    should('searchWebsiteAccess prioritize longer matches', () => {
        const result = searchWebsiteAccess('swap', testData)
        if (!result.length) return false
        return result[0]?.website.websiteOrigin === 'https://uniswap.org'
    })

    should('searchWebsiteAccess handle special characters in search', () => {
        const result = searchWebsiteAccess('https://', testData)
        return result.length > 0
    })

    should('searchWebsiteAccess handle regex special characters', () => {
        const result = searchWebsiteAccess('.*+?^${}()|[]\\', testData)
        return result.length === 0 // Should not throw and return no matches
    })

    should('searchWebsiteAccess handle empty string', () => {
        const result = searchWebsiteAccess('', testData)
        return result.length === testData.length // Should return all entries
    })

    should('searchWebsiteAccess sort multiple matches by match length', () => {
        // Create test data with similar but different length matches
        const testEntries: WebsiteAccessArray = [
            createWebsiteAccess('Swap', 'https://swap.org'),
            createWebsiteAccess('Uniswap', 'https://uniswap.org'),
            createWebsiteAccess('SwapMeet', 'https://swapmeet.org')
        ]
        const result = searchWebsiteAccess('swap', testEntries)
        if (!result.length) return false
        return result[0]?.website.websiteOrigin === 'https://uniswap.org' && // longest match
               result[1]?.website.websiteOrigin === 'https://swapmeet.org' && // second longest
               result[2]?.website.websiteOrigin === 'https://swap.org' // shortest match
    })

    should('searchWebsiteAccess handle unicode characters', () => {
        const unicodeTestData: WebsiteAccessArray = [
            createWebsiteAccess('Café', 'https://café.org'),
            createWebsiteAccess('München', 'https://münich.de'),
            createWebsiteAccess('東京', 'https://東京.jp')
        ]
        const result1 = searchWebsiteAccess('café', unicodeTestData)
        const result2 = searchWebsiteAccess('münich', unicodeTestData)
        const result3 = searchWebsiteAccess('東京', unicodeTestData)
        return result1[0]?.website.websiteOrigin === 'https://café.org' &&
               result2[0]?.website.websiteOrigin === 'https://münich.de' &&
               result3[0]?.website.websiteOrigin === 'https://東京.jp'
    })

    should('searchWebsiteAccess handle mixed case patterns', () => {
        const result = searchWebsiteAccess('UnIsWaP', testData)
        return result.some(x => x.website.websiteOrigin === 'https://uniswap.org')
    })
}

await runIfRoot(async  () => {
	await main()
	await run()
}, import.meta)
