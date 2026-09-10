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
