// Whether a client is still the one its owner has installed, as opposed to replaced by a reset. Whoever constructs a client must supply it, so a refresh can ask the client it was handed instead of holding the owner.
export type ClientLiveness = () => boolean

// For a client that no owner installs or replaces, such as a temporary lookup client: nothing can retire it.
export const alwaysLive: ClientLiveness = () => true
