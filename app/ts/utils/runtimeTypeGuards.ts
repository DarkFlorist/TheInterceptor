export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const getRecordProperty = (record: Record<string, unknown>, property: string): unknown => record[property]
