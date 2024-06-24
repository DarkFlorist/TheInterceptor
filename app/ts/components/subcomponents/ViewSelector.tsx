import { Signal, useComputed, useSignal } from '@preact/signals'
import { ComponentChildren, createContext } from 'preact'
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
			<div class = 'grid' style = { { gridTemplateColumns: '1fr', alignItems: 'start', rowGap: '0.25rem' } }>{ children }</div>
		</ViewSelectorContext.Provider>
	)
}


const useViewSwitcher = () => {
	const context = useContext(ViewSelectorContext)
	if (context === undefined) throw new Error('useViewSwitcher can only be used within children of DisplayRoot')
	return context
}

const List = ({ children }: { children: ComponentChildren }) => {
	return <div>{ children }</div>
}

const View = ({ children, title, value }: ViewConfig & { children: ComponentChildren }) => {
	const context = useViewSwitcher()

	const activeView = useComputed(() => context.views.value.find(view => view.isActive === true))

	useEffect(() => {
		const isActiveSet = context.views.value.length < 1
		context.views.value = [...context.views.peek(), { title, value, isActive: isActiveSet }]
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
