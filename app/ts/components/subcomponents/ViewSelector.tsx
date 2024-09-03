import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { ComponentChildren, createContext, toChildArray } from 'preact'
import { useContext, useEffect } from 'preact/hooks'

type ViewConfig = {
	title: string
	value: string
	isActive?: boolean
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
	const context = useViewSwitcher()
	const activeView = useComputed(() => context.views.value.find(view => view.isActive === true))
	useEffect(() => {
		context.views.value = [...context.views.peek(), { title, value, isActive }]
	}, [])
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
				<label>
					<input type = 'radio' name = { id } value = { view.value } defaultChecked = { view.isActive } />
					<span>{ view.title }</span>
				</label>
			)) }
		</fieldset>
	)
}

ViewSelector.List = List
ViewSelector.View = View
ViewSelector.Triggers = Triggers
