// Whether a client is still the one its owner has installed. Whoever constructs a client must state it, so a refresh can ask the client it was handed instead of holding the owner.
export type ClientCurrency = () => boolean

// For a client that no owner installs or replaces, such as a temporary lookup client: nothing can make it stale.
export const alwaysCurrent: ClientCurrency = () => true
