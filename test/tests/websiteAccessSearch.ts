import { should, describe, run, runIfRoot } from '../micro-should.js'
import { searchWebsiteAccess } from '../../app/ts/background/websiteAccessSearch.js'
import { WebsiteAccess, WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { addressString } from '../../app/ts/utils/bigint.js'

// Helper function to create test data
const createWebsiteAccess = (title: string | undefined, origin: string, addresses: string[] = []): WebsiteAccess => ({
    website: { title, websiteOrigin: origin, icon: undefined },
    addressAccess: addresses.length ? addresses.map(addr => ({ address: BigInt(addr), access: true })) : undefined
})

export async function main() {
    const testData: WebsiteAccessArray = [
        createWebsiteAccess('Ethereum Foundation', 'ethereum.org', ['0x123']),
        createWebsiteAccess('Uniswap', 'app.uniswap.org', ['0x789']),
        createWebsiteAccess(undefined, 'etherscan.io', ['0xabc']),
        createWebsiteAccess('OpenSea', 'opensea.io', []),
        createWebsiteAccess('Lunaria', 'lunaria.dark.florist', []),
    ]

    describe('searchWebsiteAccess', () => {
        should('return original array reference for empty query', () => {
            const result = searchWebsiteAccess('', testData)
            return result === testData
        })

        should('return all entries for whitespace-only query', () => {
            const result = searchWebsiteAccess('   ', testData)
            return result.length === testData.length
        })

        should('match partial word "lu" with Lunaria', () => {
            const result = searchWebsiteAccess('lu', testData)
            return result[0] === testData[4] // Lunaria should be first match
        })

        should('find website by title', () => {
            const result = searchWebsiteAccess('ethereum', testData)
            return result[0] === testData[0] // Ethereum Foundation should be first
        })

        should('find website by origin', () => {
            const result = searchWebsiteAccess('uniswap', testData)
            return result[0] === testData[1] // Uniswap should be first
        })

        should('find website by ethereum address', () => {
            const result = searchWebsiteAccess('0x123', testData)
            return result[0] === testData[0] // Entry with 0x123 should be first
        })

        should('match website with undefined title', () => {
            const result = searchWebsiteAccess('etherscan', testData)
            return result[0] === testData[2]
        })

        should('prioritize exact matches over partial matches', () => {
            const result = searchWebsiteAccess('etherscan', testData)
            // etherscan.io should be first (exact match), ethereum.org should be second (partial match)
            return result[0] === testData[2] && result[1] === testData[0]
        })

        should('rank longer matches higher', () => {
            const result = searchWebsiteAccess('swap', testData)
            if (!result.length) return false
            return result[0]?.website.websiteOrigin === 'https://uniswap.org'
        })

        should('sort matches by match length in descending order', () => {
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

        should('match non-sequential characters', () => {
            const result = searchWebsiteAccess('usp', testData)
            return result.some((x) => x.website.websiteOrigin === 'https://uniswap.org')
        })

        should('find partial ethereum address matches', () => {
            const result = searchWebsiteAccess('0x1234', testData)
            return result.some((x) => x.addressAccess?.some((addr) => addressString(addr.address).toLowerCase().includes('0x1234')))
        })

        should('perform case-insensitive search', () => {
            const result = searchWebsiteAccess('ETHEREUM', testData)
            return result[0] === testData[0]
        })

        should('match mixed case patterns', () => {
            const result = searchWebsiteAccess('UnIsWaP', testData)
            return result.some((x) => x.website.websiteOrigin === 'https://uniswap.org')
        })

        should('handle URLs with special characters', () => {
            const result = searchWebsiteAccess('https://', testData)
            return result.length > 0
        })

        should('safely handle regex special characters', () => {
            const result = searchWebsiteAccess('.*+?^${}()|[]\\', testData)
            return result.length === 0 // Should not throw and return no matches
        })

        should('support unicode characters', () => {
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
    })
}

runIfRoot(async () => {
    await main()
    await run()
}, import.meta)
