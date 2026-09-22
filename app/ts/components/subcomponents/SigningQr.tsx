import { useEffect, useRef, useState } from 'preact/hooks'
import encodeQR from 'qr'
import { BarcodeDetector } from 'qr/decode.js'
import { createAirGapUrEncoder } from '../../signing/airgapUr.js'

export function AnimatedSigningQr({ payload }: { payload: Uint8Array }) {
	const [sequence, setSequence] = useState(1)
	const [paused, setPaused] = useState(false)
	const [interval, setIntervalMs] = useState(250)
	const encoder = createAirGapUrEncoder('eth-sign-request', payload)
	useEffect(() => {
		if (paused) return
		const timer = setInterval(() => setSequence((value) => value >= 4096 ? 1 : value + 1), interval)
		return () => clearInterval(timer)
	}, [paused, interval])
	return <section>
		<img width = '400' height = '400' alt = 'AirGap Vault signing request' src = { encodeQR(encoder.part(sequence).toUpperCase(), 'data-url', { scale: 4, border: 4, ecc: 'medium' }) }/>
		<p>Frame { sequence } · { encoder.count } source fragments</p>
		<button class = 'button' onClick = { () => setPaused(!paused) }>{ paused ? 'Play' : 'Pause' }</button>
		<button class = 'button' onClick = { () => setSequence((value) => value + 1) }>Next frame</button>
		<label>Animation speed <select value = { interval } onChange = { (event) => setIntervalMs(Number(event.currentTarget.value)) }><option value = '500'>Slow</option><option value = '250'>Normal</option><option value = '125'>Fast</option></select></label>
	</section>
}

/** Bound each frame to 640 × 480; release the camera on completion, cancellation, and unmount. */
export function SigningQrScanner({ onFrame }: { onFrame: (frame: string) => Promise<boolean> }) {
	const video = useRef<HTMLVideoElement>(null)
	const stop = useRef<(() => void) | undefined>()
	const [running, setRunning] = useState(false)
	const [error, setError] = useState<string>()
	const mounted = useRef(true)
	useEffect(() => () => { mounted.current = false; stop.current?.() }, [])
	const start = async () => {
		// Reserve the session synchronously, including time spent waiting for camera permission.
		if (stop.current !== undefined || !mounted.current) return
		let stopped = false
		let stream: MediaStream | undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		const stopSession = () => {
			stopped = true
			clearTimeout(timer)
			for (const track of stream?.getTracks() ?? []) track.stop()
			if (stop.current !== stopSession) return
			stop.current = undefined
			if (mounted.current) setRunning(false)
		}
		const failSession = (failure: unknown, fallback: string) => {
			if (!stopped && mounted.current) setError(failure instanceof Error ? failure.message : fallback)
			stopSession()
		}
		stop.current = stopSession
		setRunning(true)
		setError(undefined)
		try {
			if (navigator.mediaDevices?.getUserMedia === undefined) throw new Error('Camera scanning is unavailable in this browser')
			stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' }, audio: false })
			if (stopped || !mounted.current || video.current === null) { stopSession(); return }
			video.current.srcObject = stream
			await video.current.play()
			if (stopped || !mounted.current) { stopSession(); return }
			const canvas = document.createElement('canvas')
			canvas.width = 640
			canvas.height = 480
			const context = canvas.getContext('2d', { willReadFrequently: true })
			if (context === null) throw new Error('Camera image processing is unavailable')
			const detector = new BarcodeDetector({ formats: ['qr_code'] })
			const scan = async () => {
				if (stopped || video.current === null) return
				try {
					context.drawImage(video.current, 0, 0, 640, 480)
					const frames = await detector.detect(context.getImageData(0, 0, 640, 480))
					for (const frame of frames) {
						if (stopped) return
						if (frame.rawValue.length > 8192) throw new Error('QR frame exceeds the supported size')
						if (await onFrame(frame.rawValue)) { stopSession(); return }
					}
					if (!stopped) timer = setTimeout(() => { void scan() }, 150)
				} catch (failure) { failSession(failure, 'Unable to scan QR code') }
			}
			await scan()
		} catch (failure) { failSession(failure, 'Camera permission was denied or the camera is unavailable') }
	}
	return <section>
		<video ref = { video } muted playsInline style = 'max-width: 100%; width: 400px;'/>
		<button class = 'button' disabled = { running } onClick = { () => { void start() } }>Enable camera</button>
		{ running ? <button class = 'button' onClick = { () => stop.current?.() }>Stop camera</button> : undefined }
		{ error === undefined ? undefined : <p role = 'alert'>{ error }. Check camera permissions and retry.</p> }
	</section>
}
