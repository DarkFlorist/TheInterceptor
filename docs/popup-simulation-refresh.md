# Popup simulation refresh ownership

`popupVisualisationUpdater.ts` is the shared execution layer. Its semaphore serializes visualization execution for both queued and direct callers. It owns the abort controller, visibility/throttling checks, visualization construction, and publication. The queue is an optional scheduling policy above this layer, not a replacement for it or a global ordering guarantee.

## Choosing an entry point

| Need | Entry point | Contract |
| --- | --- | --- |
| Interactive settings changes, reset, or explicit refresh | `queuePopupSimulationRefresh` in `popupSimulationRefreshQueue.ts` | Capture input and rich-count together; share equivalent revisions, keep the latest pending request, carry invalidation forward, and settle each executed entry with its own outcome. Superseded queued requests return `status: 'superseded'`, not a failure. Reset forces invalidation after clearing the stack. |
| Complete-visualization requests, new-block updates, throttled editing, or existing flows that require an immediate refresh attempt | `updatePopupVisualisationIfNeeded` | Probe for an open consumer, optionally skip recent/unchanged work, and cancel obsolete cancellable execution. Returns the stored visualization, not a queued caller's success flag. |
| Bootstrap for an already-open consumer | `refreshPopupVisualisationForOpenConsumer` | Avoid another visibility probe; report unexpected errors and return the stored fallback so other bootstrap data can still load. |
| Import/persistence that must observe visualization errors | `updatePopupVisualisationState` | Execute under the same semaphore without visibility/throttling checks; `throwOnUnexpectedError` lets the caller report persistence failure explicitly. |

The direct paths deliberately retain their existing contracts. A block update must be able to cancel obsolete work promptly; an import cannot silently become a superseded queue entry; bootstrap must not depend on a second open-consumer probe. Routing these paths through a latest-pending queue would change those guarantees.

Queue identity and supersession apply only among queue callers. Direct execution may run between queued entries or cancel their underlying cancellable execution. An executed queue entry returns `status: 'observed'` with the stored visualization's availability after its attempt. It does not attribute that state to a particular request or promise that it remains unchanged afterward. Superseded entries never report availability; callers must not interpret supersession as a simulation failure. All paths use the execution layer's serialization and storage/publication logic.

When adding a trigger, choose the required cancellation, visibility, error, and return-value contract from the table. Changes to visualization execution belong in `popupVisualisationUpdater.ts`; changes to interactive sharing/supersession belong in `popupSimulationRefreshQueue.ts`.

`captureSimulationSnapshot` reads the selected network, stack context, input and rich count at the storage boundary. Execution requires that snapshot; cache checks and execution share `getSimulationProviderForSnapshot`, which uses its network selection without re-reading global settings. Signer-only snapshots expose no simulation provider even though the service owner retains a supported provider for a later configured selection. The interactive queue carries the same snapshot through fingerprinting and execution. A missing RPC URL cannot be used to construct replacement RPC services.

External-wallet signing transitions do not enqueue simulation refreshes: wallet acknowledgment depends on applying the selected network, not RPC simulation availability. Simulation-mode transitions and selected Safe signing stacks retain their visualization refreshes.

`updatePopupVisualisationIfNeeded` takes named options for invalidation, throttling, unchanged-input skipping, and a captured snapshot. Omitted options keep the normal direct-refresh behavior. The interactive queue supplies its captured snapshot and owns coalescing; the executor owns serialization.

Active settings commands receive `SimulationServicesOwner`, not a service pair captured before waiting for the transition semaphore. They read `getCurrent()` when preparing the refresh, so a preceding endpoint reset supplies the installed services. Both popup and dapp RPC requests enter `changeActiveRpc` in `walletSwitch.ts`, which owns routing, shared Safe network restrictions, local promotion, and correlated wallet dispatch.

The intercepted-request pipeline also carries only the service owner. Provider callbacks obtain services when their work starts. Access admission, dialog callbacks, resolution, and permission persistence carry only the owner across user waits; replayed requests select the current services after approval. RPC execution captures one pair after admission and uses it for both lazy simulation preparation and RPC handling; permission persistence carries the owner into any subsequent prompts. An in-flight RPC does not switch providers halfway through execution.

## Popup handler service contracts

Choose the registration that describes the operation:

| Registration | Handler context | Boundary |
| --- | --- | --- |
| `popupMessageHandler` | Live service owner | Orchestration, settings transitions, opening/resolving prompts, or work that must follow the current selection after a wait. Pass the owner through the wait and obtain services when the next execution stage begins. |
| `popupSnapshotMessageHandler` | `PopupSnapshotContext.services`, without the owner or reset callback | One fixed-provider operation. The registry captures the pair at invocation, not registration; asynchronous work within that operation retains the same pair. A later invocation sees the newly installed pair. |

Transaction confirmation uses the owner registration and obtains services after refreshing wallet accounts. Visualization, metadata, and simulation operations use the snapshot registration where their existing execution contract requires a fixed pair. Do not use a snapshot registration to orchestrate a new user prompt or continue against a newly selected endpoint after that prompt; those stages need the owner contract.

`SimulationServicesOwner.reset()` stops the replaced client's background polling and installs a new pair. `EthereumClientService.cleanup()` does not destroy its request handler, clear its endpoint, or invalidate RPC methods: an already-started snapshot can still finish against its original provider. A snapshot is therefore a fixed endpoint, not a promise to represent the latest selection. It must not be reused for a later independent operation. The registry types make that choice visible and prevent snapshot handlers from calling owner-based lifecycle APIs through their context.
