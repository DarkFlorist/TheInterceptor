export type UserConfig = {
    address: string,
    disabledProtections: Set<number>
}

export interface TokenVisualizerData {
    readonly tokenAddress: string
    readonly uintData: string
    readonly from: string
    readonly to: string
    readonly is721: boolean,
    readonly isApproval: boolean
    readonly isAllApproval: boolean
}

export interface EthBalanceChangeData {
    address: string,
    before: string,
    after: string,
}

export interface VisualizerData {
    readonly ethBalanceChanges: EthBalanceChangeData[]
    readonly tokenResults: TokenVisualizerData[]
}

export type TransactionEntry = {
    type: "legacy" | "2930" | "1559"
    from: string
    to: string | undefined
    nonce: bigint
    gas: string
    input: string
    value: string
    hash: string
    gasPrice: string | undefined
    maxFeePerGas: string | undefined
    maxPriorityFeePerGas: string | undefined,
    chainId: bigint | undefined
    seenTimestamp: number
    raw: string
    quarantined: boolean
    quarantineCodes: number[]
    forcedTimestamp: number | undefined
    visualizerData: VisualizerData | undefined
}

export type TransactionEntryCensored = Omit<TransactionEntry, "raw">
