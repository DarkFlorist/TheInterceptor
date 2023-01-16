const CACHE_SIZE = 100

export class DataURLCache {
	private readonly dataURLs = new Map<string, string>()
	public has = (key: string) => this.dataURLs.has(key)
	public get = (key: string) => this.dataURLs.get(key)
	public set = (image: string, key: string) => {
		if (this.dataURLs.size > CACHE_SIZE) this.dataURLs.delete(this.dataURLs.keys().next().value)
		this.dataURLs.set(key, image)
		return image
	}
}
