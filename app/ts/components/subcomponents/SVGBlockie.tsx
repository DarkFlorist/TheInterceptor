import { useMemo } from 'preact/hooks'
import { JSX } from 'preact/jsx-runtime'
import { addressString } from '../../utils/bigint.js'

function generateIdenticon(options: { address: bigint; size?: number }) {
	// NOTE -- Majority of this code is referenced from: https://github.com/alexvandesande/blockies
	// Mostly to ensure congruence to Ethereum Mist's Identicons

	// The random number is a js implementation of the Xorshift PRNG
	const randseed: number[] = new Array(4) // Xorshift: [x, y, z, w] 32 bit values

	function seedrand(seed: string) {
		for (let i = 0; i < randseed.length; i++) {
			randseed[i] = 0
		}
		for (let i = 0; i < seed.length; i++) {
			const r = randseed[i % 4]
			if (r === undefined) throw new Error('Buffer overflow')
			randseed[i % 4] = ((r << 5) - r) + seed.charCodeAt(i)
		}
	}

	function rand() {
		// based on Java's String.hashCode(), expanded to 4 32bit values
		if (randseed[0] === undefined || randseed[1] === undefined || randseed[2] === undefined || randseed[3] === undefined) throw new Error('Buffer overflow')
		const t = randseed[0] ^ (randseed[0] << 11)

		randseed[0] = randseed[1]
		randseed[1] = randseed[2]
		randseed[2] = randseed[3]
		randseed[3] = (randseed[3] ^ (randseed[3] >> 19) ^ t ^ (t >> 8))

		return (randseed[3] >>> 0) / ((1 << 31) >>> 0)
	}

	function createColor() {
		// saturation is the whole color spectrum
		const h = Math.floor(rand() * 360)
		// saturation goes from 40 to 100, it avoids greyish colors
		const s = ((rand() * 60) + 40) + '%'
		// lightness can be anything from 0 to 100, but probabilities are a bell curve around 50%
		const l = ((rand() + rand() + rand() + rand()) * 25) + '%'

		const color = 'hsl(' + h + ',' + s + ',' + l + ')'
		return color
	}

	function createImageData(size: number) {
		const width = size // Only support square icons for now
		const height = size

		const dataWidth = Math.ceil(width / 2)
		const mirrorWidth = width - dataWidth

		const data = []
		for (let y = 0; y < height; y++) {
			let row = []
			for (let x = 0; x < dataWidth; x++) {
				// this makes foreground and background color to have a 43% (1/2.3) probability
				// spot color has 13% chance
				row[x] = Math.floor(rand() * 2.3)
			}
			const r = row.slice(0, mirrorWidth)
			r.reverse()
			row = row.concat(r)

			for (let i = 0; i < row.length; i++) {
				const rowAtIndex = row[i]
				if (rowAtIndex === undefined) throw new Error('row[i] was undefined')
				data.push(rowAtIndex)
			}
		}

		return data
	}

	const seed = addressString(options.address)

	seedrand(seed)

	const color = createColor()
	const bgcolor = createColor()
	const spotcolor = createColor()
	const imageData = createImageData(options.size || 8)

	return { imageData, color, bgcolor, spotcolor }
}

type SVGBlockieProps = {
	style?: JSX.CSSProperties
	address: bigint
}

// SVGBlockie component can be resized through CSS font size
export function Blockie({ address, style }: SVGBlockieProps) {
	const pixelDensity = 8
	const { imageData, color, spotcolor, bgcolor } = useMemo(() => generateIdenticon({ address, size: pixelDensity }), [address])
	return (
		<svg width = '1em' height = '1em' viewBox = '0 0 64 64' xmlns = 'http://www.w3.org/2000/svg' { ...( style ? { style } : {}) }>
			{ imageData.map((data, index) => {
				const fill = data === 0 ? bgcolor : data === 1 ? color : spotcolor
				const pixelSize = 64 / pixelDensity

				return <rect width = { pixelSize } height = { pixelSize } x = { ((index % pixelDensity) * 64) / pixelDensity } y = { Math.floor(index / pixelDensity) * pixelSize } fill = { fill } shape-rendering = 'crispEdges' />
			}) }
		</svg>
	)
}
