import { createStorageWriteTracking, type StorageWriteValue } from './storageWriteTracking.js'

// Every local-storage writer uses this owner, including alternate schemas and large-state fallbacks. Registration precedes the browser call synchronously.
const writes = createStorageWriteTracking()
export const captureStorageWritesTo = (key: string, value: StorageWriteValue) => writes.capture(key, value)
export const writeLocalStorage = async (items: Readonly<Record<string, unknown>>) => await writes.write(items, async () => await browser.storage.local.set(items))
