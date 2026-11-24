import { type ReadonlySignal, useComputed, useSignal } from '@preact/signals'
import type { RichTokenOption } from '../../types/richMode.js'
import { getMatchingRichTokenOptions, getRichTokenIdentityKey } from '../../utils/richTokens.js'
import { assertNever } from '../../utils/typescript.js'

export type RichTokenFilter = 'All' | 'ERC20' | 'ERC1155'

const MAX_RECENT_RICH_TOKENS = 5

// The transient state of the token picker over availableTokens: search, type filter, keyboard highlight, scroll position, multi-selection and recently added tokens. It knows nothing about funding or the background.
export function useRichTokenPicker({ availableTokens }: { availableTokens: ReadonlySignal<readonly RichTokenOption[]> }) {
	const search = useSignal('')
	const filter = useSignal<RichTokenFilter>('All')
	const highlightedIndex = useSignal(0)
	const resultsScrollTop = useSignal(0)
	const selectedKeys = useSignal<readonly string[]>([])
	const recentKeys = useSignal<readonly string[]>([])

	const matchingTokens = useComputed(() => {
		const filteredByType = availableTokens.value.filter((option) => {
			switch (filter.value) {
				case 'All': return true
				case 'ERC20': return option.tokenType === 'ERC20'
				case 'ERC1155': return option.tokenType === 'ERC1155'
				default: return assertNever(filter.value)
			}
		})
		// Without a query, selected tokens come first, then recently added ones in recency order.
		const candidates = search.value.trim() === ''
			? [...filteredByType].sort((first, second) => {
				const firstSelected = selectedKeys.value.includes(getRichTokenIdentityKey(first))
				const secondSelected = selectedKeys.value.includes(getRichTokenIdentityKey(second))
				if (firstSelected !== secondSelected) return firstSelected ? -1 : 1
				const firstIndex = recentKeys.value.indexOf(getRichTokenIdentityKey(first))
				const secondIndex = recentKeys.value.indexOf(getRichTokenIdentityKey(second))
				if (firstIndex === -1 && secondIndex === -1) return 0
				if (firstIndex === -1) return 1
				if (secondIndex === -1) return -1
				return firstIndex - secondIndex
			})
			: filteredByType
		return getMatchingRichTokenOptions(candidates, search.value)
	})
	const activeIndex = useComputed(() => Math.min(highlightedIndex.value, Math.max(0, matchingTokens.value.length - 1)))
	const selectedTokens = useComputed(() => availableTokens.value.filter((option) => selectedKeys.value.includes(getRichTokenIdentityKey(option))))

	const toggleSelection = (option: RichTokenOption) => {
		const key = getRichTokenIdentityKey(option)
		selectedKeys.value = selectedKeys.value.includes(key) ? selectedKeys.value.filter((selectedKey) => selectedKey !== key) : [...selectedKeys.value, key]
	}
	const handleSearchKeyDown = (event: Pick<KeyboardEvent, 'key' | 'preventDefault'>) => {
		const options = matchingTokens.value
		if (options.length === 0) return
		if (event.key === 'ArrowDown') {
			event.preventDefault()
			highlightedIndex.value = (highlightedIndex.value + 1) % options.length
			return
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault()
			highlightedIndex.value = (highlightedIndex.value - 1 + options.length) % options.length
			return
		}
		if (event.key !== 'Enter') return
		event.preventDefault()
		const option = options[activeIndex.value]
		if (option !== undefined) toggleSelection(option)
	}

	const data = useComputed(() => ({
		activeRichTokenIndex: activeIndex.value,
		matchingAvailableRichTokens: matchingTokens.value,
		recentRichTokenKeys: recentKeys.value,
		richTokenFilter: filter.value,
		richTokenResultsScrollTop: resultsScrollTop.value,
		richTokenSearch: search.value,
		selectedAvailableRichTokens: selectedTokens.value,
		selectedRichTokenKeys: selectedKeys.value,
	}))

	return {
		data,
		selectedTokens,
		actions: {
			setSearch: (query: string) => { search.value = query; highlightedIndex.value = 0 },
			selectFilter: (nextFilter: RichTokenFilter) => { filter.value = nextFilter; highlightedIndex.value = 0 },
			clearSelection: () => { selectedKeys.value = [] },
			scrollResults: (top: number) => { resultsScrollTop.value = top },
			highlightToken: (index: number) => { highlightedIndex.value = index },
			toggleSelection,
			handleSearchKeyDown,
			deselect: (keys: readonly string[]) => { selectedKeys.value = selectedKeys.value.filter((key) => !keys.includes(key)) },
			rememberRecent: (key: string) => { recentKeys.value = [key, ...recentKeys.value.filter((recentKey) => recentKey !== key)].slice(0, MAX_RECENT_RICH_TOKENS) },
			// Recently added tokens survive a reset; they describe the user's history, not the open dialog.
			reset: () => {
				search.value = ''
				filter.value = 'All'
				highlightedIndex.value = 0
				resultsScrollTop.value = 0
				selectedKeys.value = []
			},
		},
	}
}
