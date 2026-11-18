/**
 * All driver definitions, in detection order. Each definition may carry a `demo` entry with a
 * device simulator that speaks the real protocol over an in-memory link.
 *
 * @type {Array<import('@ubms/bms-core/driver').DriverDefinition & { demo?: { name: string, chunkSize?: number, create: (link: import('@ubms/transport').Link) => { stop?: () => void } } }>}
 */
export const drivers = [];
