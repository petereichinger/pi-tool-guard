export type PermissionRequestRunner = <T>(request: () => Promise<T>) => Promise<T>;

/**
 * Serializes interactive permission requests. A request evaluates the current
 * rules only after every earlier request has finished, so a rule saved by one
 * agent can satisfy a request that another agent had already queued.
 */
export function createPermissionRequestRunner(): PermissionRequestRunner {
	let tail: Promise<void> = Promise.resolve();

	return async <T>(request: () => Promise<T>): Promise<T> => {
		const previous = tail;
		let release!: () => void;
		tail = new Promise<void>((resolve) => {
			release = resolve;
		});

		await previous;
		try {
			return await request();
		} finally {
			release();
		}
	};
}
