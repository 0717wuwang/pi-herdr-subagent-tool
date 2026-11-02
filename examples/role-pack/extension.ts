import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const roles = fileURLToPath(new URL("./roles", import.meta.url));

export default function rolePack(pi: ExtensionAPI) {
	const unsubscribe = pi.events.on(
		"pi-herdr-subagents:roles:discover:v1",
		(request) => {
			// SAFETY: the roles:discover event always carries this contract shape;
			// docs/roles.md defines it and apiVersion is checked before any call.
			const discovery = request as {
				apiVersion: number;
				register(path: string): void;
			};
			if (discovery.apiVersion === 1) discovery.register(roles);
		},
	);
	pi.on("session_shutdown", unsubscribe);
}
