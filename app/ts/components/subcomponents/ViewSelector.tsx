import { type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { type ComponentChildren, createContext, toChildArray } from 'preact'
import { useContext, useEffect, useRef } from 'preact/hooks'

export type ViewConfig = {
	title: string
	value: string
	isActive?: boolean
}

type ViewActivationUpdate = 'activate' | 'deactivate' | 'preserve'

export function synchronizeViewConfig(views: readonly ViewConfig[], nextView: ViewConfig, activationUpdate: ViewActivationUpdate): ViewConfig[] {
	const existingView = views.find(view => view.value === nextView.value)
	if (existingView === undefined) {
		return [
			...views.map(view => activationUpdate === 'activate' ? { ...view, isActive: false } : view),
			{ ...nextView, isActive: activationUpdate === 'activate' },
		]
	}
	return views.map((view) => {
		if (view.value !== nextView.value) return activationUpdate === 'activate' ? { ...view, isActive: false } : view
		return {
			...nextView,
			isActive: activationUpdate === 'activate' ? true : activationUpdate === 'deactivate' ? false : view.isActive,
		}
	})
}

type ViewSelectorContext = {
	id: string
	views: Signal<ViewConfig[]>
	setActiveView: (value: string) => void
}

const ViewSelectorContext = createContext<ViewSelectorContext | undefined>(undefined)

export const ViewSelector = ({ children, id }: { children: ComponentChildren, id: string }) => {
	const views = useSignal<ViewConfig[]>([])
	const setActiveView = (value: string) => {
		views.value = views.peek().map(view => ({ ...view, isActive: view.value === value }))
	}
	return (
		<ViewSelectorContext.Provider value = { { id, views, setActiveView } }>
			<div class = 'grid view-selector'>{ children }</div>
		</ViewSelectorContext.Provider>
	)
}

const useViewSwitcher = () => {
	const context = useContext(ViewSelectorContext)
	if (context === undefined) throw new Error('useViewSwitcher can only be used within children of DisplayRoot')
	return context
}

const List = ({ children }: { children: ComponentChildren }) => {
	const { views } = useViewSwitcher()

	const isActiveViewDefined = useComputed(() => views.value.some(view => view.isActive === true)) 
	const hasAllChildrenRendered = useComputed(() => toChildArray(children).length === views.value.length)

	useSignalEffect(() => {
		if (!hasAllChildrenRendered.value || isActiveViewDefined.value) return
		const [firstChild, ...restOfChildren] = views.peek()
		if (firstChild === undefined) return
		views.value = [{ ...firstChild, isActive: true }, ...restOfChildren]
	})

	return <div>{ children }</div>
}

const View = ({ children, title, value, isActive }: ViewConfig & { children: ComponentChildren }) => {
	const { views } = useViewSwitcher()
	const activeView = useComputed(() => views.value.find(view => view.isActive === true))
	const previousRegistration = useRef<{ value: string, isActive: boolean | undefined } | undefined>(undefined)
	useEffect(() => {
		const previous = previousRegistration.current
		const isInitialRegistration = previous?.value !== value
		const activationUpdate: ViewActivationUpdate = isActive === true && (isInitialRegistration || previous.isActive !== true)
			? 'activate'
			: !isInitialRegistration && isActive === false && previous.isActive !== false
				? 'deactivate'
				: 'preserve'
		views.value = synchronizeViewConfig(views.peek(), { title, value, isActive }, activationUpdate)
		previousRegistration.current = { value, isActive }
	}, [views, title, value, isActive])
	useEffect(() => () => {
		views.value = views.peek().filter(view => view.value !== value)
	}, [views, value])
	if (activeView.value?.value === value) return <div>{ children }</div>
	return <></>
}

const Triggers = () => {
	const { id, views, setActiveView } = useViewSwitcher()

	const handleChange = (event: Event) => {
		if (!(event.target instanceof HTMLInputElement)) return
		setActiveView(event.target.value)
	}

	return (
		<fieldset onChange = { handleChange }>
			{ views.value.map((view) => (
				<label key = { view.value }>
					<input type = 'radio' name = { id } value = { view.value } checked = { view.isActive === true } />
					<span>{ view.title }</span>
				</label>
			)) }
		</fieldset>
	)
}

ViewSelector.List = List
ViewSelector.View = View
ViewSelector.Triggers = Triggers
