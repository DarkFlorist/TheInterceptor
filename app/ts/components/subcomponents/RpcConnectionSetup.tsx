import { useSignal, useSignalEffect } from '@preact/signals'
// import { RpcEntry } from '../../types/rpc.js'
import { JSX } from 'preact/jsx-runtime'
import { useRef } from 'preact/hooks'


export const SetupNewRpc = () => {
	const modalRef = useRef<HTMLDialogElement>(null)
	const modalShown = useSignal(false)

	const createRpcConnection = (event: JSX.TargetedEvent<HTMLFormElement>) => {
		const formData = new FormData(event.currentTarget)
		const rpcData = {
			name: formData.get('name'),
			chainId: formData.get('chainId'),
			httpsRpc: formData.get('httpsRpc'),
			currencyName: formData.get('currencyName'),
		}

		console.info(rpcData)

		// const result = RpcEntry.safeParse(rpcData)
		// console.info(result)
	}

	useSignalEffect(() => {
		if (!modalRef.current) return
		if (modalShown.value === true) modalRef.current.showModal()
	})

	return (
		<>
			<div style={ { marginLeft: 9, marginRight: 9 } }><SetupNewRPCButton onClick={ () => { modalShown.value = !modalShown.peek() } } /></div>
			<dialog className="dialog" ref={ modalRef }>
				<form method="dialog" onSubmit={ createRpcConnection }>
					<header className='dialog-header'>
						<span style={ { color: 'white', fontWeight: 'bold' } }>Add RPC Connection</span>
						<button className="button button--ghost" aria-label='close' style={ { padding: '10px' } }>
							<span class='button-icon' style={ { fontSize: '1.5em' } }>&times;</span>
						</button>
					</header>
					<main class='dialog-main'>
						<div class='fields-grid' style={ { minWidth: '25em' } }>
							<label for="rpc_name">Network Name:</label>
							<input id="rpc_name" class='input' type='text' name='name' />
							<label for="rpc_chain_id">Chain ID:</label>
							<input id="rpc_chain_id" class='input' type='text' name='chainId' />
							<label for="rpc_url">RPC URL:</label>
							<input id="rpc_url" class='input' type='text' name='httpsRpc' />
							<label for="rpc_currency">Currency Name:</label>
							<input id="rpc_currency" class='input' type='text' name='currencyName' />
						</div>
					</main>
					<footer class='dialog-footer'>
						<button class='button'>Cancel</button>
						<button class='button is-primary' type="submit">Add</button>
					</footer>
				</form>
			</dialog>
		</>
	)
}

const SetupNewRPCButton = ({ onClick }: { onClick: JSX.MouseEventHandler<HTMLButtonElement> }) => {
	const buttonCssProperties: JSX.CSSProperties = { background: '#3e3e3e', color: 'grey', boxShadow: 'inset 0 0 2px #00000082', textShadow: '0 1px #232323', border: '1px dashed #585858', width: '100%' }
	return <button class='button' style={ buttonCssProperties } onClick={ onClick }>+ New RPC Connection</button>
}
