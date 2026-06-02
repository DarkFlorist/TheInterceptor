const CACHE_SIZE = 100

export class DataURLCache {
	private readonly dataURLs = new Map<string, string>()
	public has = (key: string) => this.dataURLs.has(key)
	public get = (key: string) => this.dataURLs.get(key)
	public set = (image: string, key: string) => {
		if (this.dataURLs.size > CACHE_SIZE) {
			const nextValue = this.dataURLs.keys().next().value
			if (nextValue === undefined) throw new Error('Next value was undefined in data cache.')
			this.dataURLs.delete(nextValue)
		}
		this.dataURLs.set(key, image)
		return image
	}
}
