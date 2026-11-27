// Portfolio math uses exact base units; only human-readable amounts and USD values use numbers. The adapter owns JSON mapping and validates nonnegative raw balances, decimals in [0, 255], and finite USD inputs.
export type PortfolioQuantity = { readonly raw: bigint, readonly decimals: number }
export type PortfolioValueContribution = { readonly chainId: number, readonly isHidden: boolean, readonly valueUsd: number | undefined }
export type PortfolioGroupContribution = PortfolioQuantity & { readonly isHidden: boolean, readonly valueUsd: number | undefined }

export function portfolioQuantityAmount({ raw, decimals }: PortfolioQuantity): number {
	const digits = raw.toString().padStart(decimals + 1, '0')
	if (decimals === 0) return Number(digits)
	return Number(`${ digits.slice(0, -decimals) }.${ digits.slice(-decimals) }`)
}

export function portfolioQuantityValue(quantity: PortfolioQuantity, priceUsd: number | undefined): number | undefined {
	if (priceUsd === undefined) return undefined
	const valueUsd = portfolioQuantityAmount(quantity) * priceUsd
	if (!Number.isFinite(valueUsd)) throw new Error('The simulated portfolio value exceeds the indexed API number range.')
	return valueUsd
}

const visibleValue = (contribution: { readonly isHidden: boolean, readonly valueUsd: number | undefined }) => contribution.isHidden ? 0 : contribution.valueUsd ?? 0

export function portfolioValueDelta(chainId: number, previous: readonly PortfolioValueContribution[], updated: readonly PortfolioValueContribution[]): number {
	const chainValue = (rows: readonly PortfolioValueContribution[]) => rows.reduce((sum, row) => sum + (row.chainId === chainId ? visibleValue(row) : 0), 0)
	return chainValue(updated) - chainValue(previous)
}

export const applyPortfolioValueDelta = (valueUsd: number, deltaUsd: number): number => Math.max(0, valueUsd + deltaUsd)

export function aggregatePortfolioGroup(contributions: readonly PortfolioGroupContribution[]): { readonly quantity: PortfolioQuantity, readonly valueUsd: number } {
	const visible = contributions.filter((row) => !row.isHidden)
	const decimals = Math.max(0, ...visible.map((row) => row.decimals))
	const raw = visible.reduce((sum, row) => sum + row.raw * 10n ** BigInt(decimals - row.decimals), 0n)
	return { quantity: { raw, decimals }, valueUsd: visible.reduce((sum, row) => sum + visibleValue(row), 0) }
}
