import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import before the extension: configuration is loaded during module evaluation.
const directory = mkdtempSync(join(tmpdir(), "initfix-test-agent-"));
const configDir = join(directory, "herdr-agents");
process.env.PI_CODING_AGENT_DIR = directory;
// child 场景从持久配置解析模型：提供含 models.default 的骨架，让派发/交接能通过模型校验。
mkdirSync(configDir, { recursive: true });
writeFileSync(
	join(configDir, "config.jsonl"),
	JSON.stringify({
		models: { default: { model: "provider/model-id", thinking: "medium" } },
		status: { enabled: true },
	}) + "\n",
);
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
