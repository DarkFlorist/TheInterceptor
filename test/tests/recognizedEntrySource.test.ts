import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EntrySource, isRecognizedEntrySource } from '../../app/ts/types/addressBookTypes.js'

describe('isRecognizedEntrySource', () => {
	test('recognizes entries the user added or The Interceptor ships, but not on-chain lookups or placeholders', () => {
		const recognitionBySource: Record<EntrySource, boolean> = { User: true, DarkFloristMetadata: true, Interceptor: true, OnChain: false, FilledIn: false }
		for (const [entrySource, recognized] of Object.entries(recognitionBySource)) assert.equal(isRecognizedEntrySource(EntrySource.parse(entrySource)), recognized, entrySource)
	})
})
