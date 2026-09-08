# Popup simulation refresh ownership

`popupVisualisationUpdater.ts` is the shared execution layer. Its semaphore serializes visualization execution for both queued and direct callers. It owns the abort controller, visibility/throttling checks, visualization construction, and publication. The queue is an optional scheduling policy above this layer, not a replacement for it or a global ordering guarantee.

## Choosing an entry point

| Need | Entry point | Contract |
| --- | --- | --- |
| Interactive settings changes, reset, or explicit refresh | `queuePopupSimulationRefresh` in `popupSimulationRefreshQueue.ts` | Capture input and rich-count together; share equivalent revisions, keep the latest pending request, carry invalidation forward, and settle each executed entry with its own outcome. Superseded queued requests resolve false. Reset forces invalidation after clearing the stack. |
| Complete-visualization requests, new-block updates, throttled editing, or existing flows that require an immediate refresh attempt | `updatePopupVisualisationIfNeeded` | Probe for an open consumer, optionally skip recent/unchanged work, and cancel obsolete cancellable execution. Returns the stored visualization, not a queued caller's success flag. |
| Bootstrap for an already-open consumer | `refreshPopupVisualisationForOpenConsumer` | Avoid another visibility probe; report unexpected errors and return the stored fallback so other bootstrap data can still load. |
| Import/persistence that must observe visualization errors | `updatePopupVisualisationState` | Execute under the same semaphore without visibility/throttling checks; `throwOnUnexpectedError` lets the caller report persistence failure explicitly. |

The direct paths deliberately retain their existing contracts. A block update must be able to cancel obsolete work promptly; an import cannot silently become a superseded queue entry; bootstrap must not depend on a second open-consumer probe. Routing these paths through a boolean-returning, latest-pending queue would change those guarantees.

Queue identity and supersession apply only among queue callers. Direct execution may run between queued entries or cancel their underlying cancellable execution. A queue result describes that entry's refresh attempt; it does not promise that the stored visualization remains unchanged afterward. All paths use the execution layer's serialization and storage/publication logic.

When adding a trigger, choose the required cancellation, visibility, error, and return-value contract from the table. Changes to visualization execution belong in `popupVisualisationUpdater.ts`; changes to interactive sharing/supersession belong in `popupSimulationRefreshQueue.ts`.

Signer-only networks keep a supported provider available for a later configured selection, but simulation returns passthrough without executing that provider. Cache-fingerprint checks also skip provider reads on signer-only networks. A missing RPC URL cannot be used to construct replacement RPC services.

External-wallet signing transitions do not enqueue simulation refreshes: wallet acknowledgment depends on applying the selected network, not RPC simulation availability. Simulation-mode transitions and selected Safe signing stacks retain their visualization refreshes.
