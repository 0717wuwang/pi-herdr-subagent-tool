import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import {
	launchOperationsFromSurface,
	launchPiSubagent,
	launchPiWorktreeHandoff,
	type FreshPiLaunchRequest,
	type PiLaunchOperations,
	type ResumePiLaunchRequest,
	type WorktreeSurfaceForLaunch,
} from "../maestro/adapters/pi/launch.ts";
import { createWorktreeOperations } from "../maestro/runtime/worktree-operations.ts";
import { createSubagentPaneFactory } from "../maestro/core/config/pane-config.ts";
import { FakeSurfaceProvider } from "../maestro/surfaces/fake/fake-surface-provider.ts";
import type { SurfaceProvider } from "../maestro/core/surface-provider.ts";
import { WorktreeProvisioningError } from "../maestro/core/surface-provider.ts";
import {
	readSubagentSessionPolicy,
	writeSubagentSessionPolicy,
} from "../maestro/adapters/pi/session.ts";

function fixture() {
	const root = mkdtempSync(
		join(tmpdir(), "subagent-launch-test-[probe](regex)-"),
	);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "parent-sessions");
	const parentSessionFile = join(sessionDir, "parent.jsonl");
	mkdirSync(project, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		parentSessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: project })}\n`,
	);

	const request: FreshPiLaunchRequest = {
		kind: "fresh",
		id: "child-1",
		name: "Worker",
		task: "Implement the bounded change.",
		agent: "worker",
		parent: {
			cwd: project,
			sessionFile: parentSessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir,
		},
		runtimePlan: {
			provider: "fake",
			modelId: "worker",
			model: "fake/worker",
			thinking: "high",
		},
		behavior: {
			tools: "read,bash",
			skills: "tdd",
			deniedTools: ["subagent", "subagent_resume"],
			autoExit: true,
			interactive: false,
			identity: "You are a focused worker.",
			systemPromptMode: "append",
			sessionMode: "standalone",
		},
	};
	return { root, project, agentDir, sessionDir, request };
}

function withFixture(
	run: (value: ReturnType<typeof fixture>) => Promise<void> | void,
) {
	const value = fixture();
	return Promise.resolve(run(value)).finally(() => {
		rmSync(value.root, { recursive: true, force: true });
	});
}

function initializeGitRepository(cwd: string): void {
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
}

function commitAll(cwd: string, message: string): string {
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["commit", "-qm", message], { cwd });
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd,
		encoding: "utf8",
	}).trim();
}

function createLinkedGitFixture(root: string, principal: string) {
	initializeGitRepository(principal);
	writeFileSync(join(principal, "base.txt"), "base\n");
	const principalSha = commitAll(principal, "base");
	const linked = join(root, "linked source α\ncheckout");
	execFileSync(
		"git",
		["worktree", "add", "-q", "-b", "linked/source", linked, principalSha],
		{ cwd: principal },
	);
	writeFileSync(join(linked, "linked.txt"), "linked\n");
	const linkedSha = commitAll(linked, "linked change");
	const linkedCwd = join(linked, "nested caller");
	mkdirSync(linkedCwd);
	return { linked, linkedCwd, linkedSha };
}

function writePublicResumePolicy(sessionFile: string): void {
	writeSubagentSessionPolicy(sessionFile, {
		owner: "public",
		tools: "read,bash",
		deniedTools: ["subagent", "subagent_resume"],
	});
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

function providerWithOverrides(
	base: FakeSurfaceProvider,
	overrides: Partial<SurfaceProvider>,
): SurfaceProvider {
	return {
		name: base.name,
		isAvailable: () => base.isAvailable(),
		createSurface: (opts) => base.createSurface(opts),
		runCommand: (surface, command) => base.runCommand(surface, command),
		readScreen: (surface, lines) => base.readScreen(surface, lines),
		closeSurface: (surface) => base.closeSurface(surface),
		listSurfaces: () => base.listSurfaces(),
		attachSurface: (surface) => base.attachSurface(surface),
		createWorktreeSurface: (opts) => base.createWorktreeSurface(opts),
		removeWorktreeSurface: (workspace) => base.removeWorktreeSurface(workspace),
		setupHint: () => base.setupHint(),
		inspectSurface: (surface) => base.inspectSurface(surface),
		sendKeys: (surface, keys) => base.sendKeys(surface, keys),
		getProcessInfo: (surface) => base.getProcessInfo(surface),
		waitForShellReady: (surface) => base.waitForShellReady(surface),
		waitForSurfaceAbsence: (surface, opts) =>
			base.waitForSurfaceAbsence(surface, opts),
		listWorktreeSurfaces: (opts) => base.listWorktreeSurfaces(opts),
		reportOpenedPrimaryWorkspace: (input) =>
			base.reportOpenedPrimaryWorkspace(input),
		focusWorkspace: (workspace) => base.focusWorkspace(workspace),
		setTitle: (target, title) => base.setTitle(target, title),
		// 默认空实现:fake provider 尚未实现新接口,通过 overrides 提供真实行为。
		splitSurface: () => "",
		startAgent: () => undefined,
		...overrides,
	};
}

describe("Pi launch", () => {
	it("launchOperationsFromSurface maps createPane to the provider's grouped placement", async () => {
		const provider = new FakeSurfaceProvider();
		const operations = launchOperationsFromSurface(provider, {
			mode: "grouped",
			direction: "right",
			maxPerTab: 4,
		});

		const surface = await operations.createPane("x", process.cwd());

		assert.equal(surface, "fake-surface-1");
		assert.equal((await provider.listSurfaces())[0]?.name, "x");
	});

	it("launchOperationsFromSurface awaits deferred cleanup before reporting a failed ordinary launch", {
		timeout: 10000,
	}, async () => {
		await withFixture(async ({ request }) => {
			const fake = new FakeSurfaceProvider();
			const closeEntered = deferred();
			const closeGate = deferred();
			let settled = false;
			const provider = providerWithOverrides(fake, {
				name: "async-fake",
				async createSurface(opts) {
					return fake.createSurface(opts);
				},
				async closeSurface(surface) {
					closeEntered.resolve();
					await closeGate.promise;
					fake.closeSurface(surface);
				},
				// startAgent 是唯一会抛出并触发关闭的失败点。
				async startAgent() {
					throw new Error("agent start rejected");
				},
			});
			const operations = launchOperationsFromSurface(provider, {
				mode: "grouped",
				direction: "right",
				maxPerTab: 4,
			});

			const launch = launchPiSubagent(request, operations);
			const observedRejection = assert.rejects(launch, /agent start rejected/);
			launch
				.finally(() => {
					settled = true;
				})
				.catch(() => {});

			await closeEntered.promise;
			await new Promise((resolve) => setImmediate(resolve));
			try {
				assert.equal(settled, false);
				assert.equal((await provider.listSurfaces()).length, 1);
			} finally {
				closeGate.resolve();
			}
			await observedRejection;
			assert.deepEqual(await provider.listSurfaces(), []);
		});
	});

	it("records recovered worktree metadata from provider provisioning errors", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			initializeGitRepository(project);
			writeFileSync(join(project, "base.txt"), "base\n");
			commitAll(project, "base");
			const provider = new FakeSurfaceProvider();
			const operations = launchOperationsFromSurface(
				providerWithOverrides(provider, {
					createWorktreeSurface() {
						throw new WorktreeProvisioningError("partial provisioning", {
							path: join(root, "partial-tree"),
							branch: "issue/partial",
							workspaceId: "workspace-partial",
						});
					},
				}),
				{ mode: "grouped", direction: "right", maxPerTab: 4 },
				createWorktreeOperations(),
			);

			await assert.rejects(
				launchPiSubagent(
					{ ...request, worktree: { branch: "issue/partial" } },
					operations,
				),
				/partial provisioning/,
			);
			const manifest = JSON.parse(
				readFileSync(
					join(
						sessionDir,
						"artifacts",
						"parent",
						"worktree-runs",
						"child-1.json",
					),
					"utf8",
				),
			);
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, join(root, "partial-tree"));
			assert.equal(manifest.branch, "issue/partial");
			assert.equal(manifest.workspaceId, "workspace-partial");
		});
	});

	for (const failed of [true, false]) {
		it(`${failed ? "reports" : "omits"} launch diagnostics without writing claims to the manifest`, async () => {
			await withFixture(async ({ request, project, sessionDir, root }) => {
				initializeGitRepository(project);
				writeFileSync(join(project, "base.txt"), "base\n");
				commitAll(project, "base");
				const worktreePath = join(root, "diagnostic-tree");
				const manifestFile = join(
					sessionDir,
					"artifacts",
					"parent",
					"worktree-runs",
					"child-1.json",
				);
				const diagnostics = [
					"Primary workspace snapshot (before create) failed: x",
				];
				const running = await launchPiSubagent(
					{ ...request, worktree: { branch: "issue/diagnostic" } },
					{
						worktree: createWorktreeOperations(),
						createPane() {
							throw new Error("unexpected pane creation");
						},
						createWorktree(_name, cwd, branch, base) {
							execFileSync(
								"git",
								["worktree", "add", "-q", "-b", branch, worktreePath, base],
								{ cwd },
							);
							const surface: WorktreeSurfaceForLaunch = {
								path: worktreePath,
								branch,
								workspaceId: "workspace-1",
								paneId: "root-pane-1",
							};
							if (failed) surface.diagnostics = diagnostics;
							return surface;
						},
						splitSurface(_pane, _cwd, _env) {
							return "root-pane-1";
						},
						startAgent() {},
						closePane() {},
					},
				);
				assert.deepEqual(
					running.worktree?.diagnostics,
					failed ? diagnostics : undefined,
				);
				const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
				assert.deepEqual(
					Object.keys(manifest).filter((key) =>
						key.startsWith("openedPrimary"),
					),
					[],
				);
			});
		});
	}

	it("launches an ordinary child through one transaction", async () => {
		await withFixture(async ({ request, project, agentDir }) => {
			const projectAgentDir = join(project, ".pi", "agent");
			mkdirSync(projectAgentDir, { recursive: true });
			const events: string[] = [];
			const closed: string[] = [];
			let argv: string[] = [];
			let launchEnv: Record<string, string> = {};
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane(name, cwd, paneEnv) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project, "placement must use the child's checkout");
					launchEnv = paneEnv ?? {};
					events.push("create");
					return "pane-1";
				},
				createWorktree() {
					throw new Error("unexpected worktree creation");
				},
				startAgent(surface, options) {
					assert.equal(surface, "pane-1");
					events.push("start");
					argv = options.argv;
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			const running = await launchPiSubagent(request, operations);

			assert.deepEqual(events, ["create", "start"]);
			assert.deepEqual(closed, []);
			assert.equal(running.id, "child-1");
			assert.equal(running.surface, "pane-1");
			assert.ok(running.sessionFile.startsWith(join(agentDir, "sessions")));
			const policy = readSubagentSessionPolicy(running.sessionFile);
			assert.equal(policy.version, 2);
			assert.equal(policy.owner, "public");
			assert.deepEqual(policy.tools, ["read", "bash"]);
			assert.deepEqual(policy.deniedTools, ["subagent", "subagent_resume"]);
			assert.equal(policy.persistent, false);
			// pi 参数是 argv 数组；`--kind pi` 已声明 agent，argv 里不再重复 pi。
			assert.equal(argv[0], "--session");
			assert.equal(argv[1], running.sessionFile);
			assert.equal(argv[2], "-e");
			assert.match(argv[3], /subagent-done\.ts$/);
			assert.equal(argv[4], "--model");
			assert.equal(argv[5], "fake/worker");
			assert.equal(argv[6], "--thinking");
			assert.equal(argv[7], "high");
			assert.equal(argv[8], "--tools");
			// autoExit=true 时不包含 subagent_done，但注入 caller_ping。
			assert.equal(argv[9], "read,bash,caller_ping");
			assert.equal(argv[10], "--append-system-prompt");
			assert.match(argv[11], /\.md$/);
			// 技能提示和任务参数。
			assert.equal(argv[12], "");
			assert.equal(argv[13], "/skill:tdd");
			assert.ok(
				argv[14].startsWith("@") && argv[14].endsWith(".md"),
				"expected artifact-backed task delivery",
			);
			const taskPath = argv[14].slice(1);
			assert.match(
				readFileSync(taskPath, "utf8"),
				/Complete your task autonomously\.[\s\S]*Implement the bounded change\./,
			);
			assert.equal(readFileSync(argv[11], "utf8"), "You are a focused worker.");
			// env 键集合:没有 PI_SUBAGENT_SURFACE,没有 PI_HERDR_AGENTS_SESSION。
			assert.equal(launchEnv.PI_SUBAGENT_SURFACE, undefined);
			assert.equal(launchEnv.PI_HERDR_AGENTS_SESSION, undefined);
			assert.equal(launchEnv.PI_SUBAGENT_NAME, "Worker");
			assert.equal(launchEnv.PI_SUBAGENT_AGENT, "worker");
			assert.equal(launchEnv.PI_SUBAGENT_ID, "child-1");
			assert.equal(launchEnv.PI_SUBAGENT_AUTO_EXIT, "1");
			assert.equal(launchEnv.PI_SUBAGENT_SESSION, running.sessionFile);
			assert.equal(launchEnv.PI_DENY_TOOLS, "subagent,subagent_resume");
			assert.ok(launchEnv.PI_SUBAGENT_ACTIVITY_FILE);
			assert.equal(launchEnv.PI_SUBAGENT_PROCESS_FILE, "");
		});
	});

	it("treats an explicit null worktree as an ordinary pane", async () => {
		await withFixture(async ({ request, project }) => {
			let worktreeCreationAttempts = 0;
			let launchEnv: Record<string, string> = {};
			let argv: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane(name, cwd, paneEnv) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					launchEnv = paneEnv ?? {};
					return "pane-null-worktree";
				},
				createWorktree() {
					worktreeCreationAttempts++;
					throw new Error("unexpected worktree creation");
				},
				startAgent(surface, options) {
					argv = options.argv;
				},
				closePane() {},
				captureProcessIdentity() {
					throw new Error("an ordinary pane captures no process identity");
				},
			};

			const running = await launchPiSubagent(
				{ ...request, worktree: null },
				operations,
			);

			assert.equal(worktreeCreationAttempts, 0);
			assert.equal(running.surface, "pane-null-worktree");
			assert.equal(running.worktree, undefined);
			// 普通 pane 不注入 process-identity 文件。
			assert.equal(launchEnv.PI_SUBAGENT_PROCESS_FILE, "");
			assert.equal(running.processIdentityFile, undefined);
			assert.equal(running.processIdentityCapture, undefined);
			// startAgent 收到非空 argv。
			assert.ok(argv.length > 0);
		});
	});

	for (const kind of ["fresh", "resume"] as const) {
		it(`closes its ${kind} pane once when startAgent fails`, async () => {
			await withFixture(async ({ request, root, sessionDir }) => {
				const pane = `pane-${kind}`;
				const closed: string[] = [];
				const sessionFile = join(root, "resumed.jsonl");
				writeFileSync(
					sessionFile,
					JSON.stringify({ type: "session", id: "resumed", cwd: root }) + "\n",
				);
				if (kind === "resume") writePublicResumePolicy(sessionFile);
				const launchRequest: FreshPiLaunchRequest | ResumePiLaunchRequest =
					kind === "fresh"
						? request
						: {
								kind: "resume",
								id: "resume-failure",
								name: "Resume worker",
								sessionFile,
								parent: { sessionId: "parent", sessionDir },
							};
				const expectedError = `${kind} startAgent failed`;
				const operations: PiLaunchOperations = {
					worktree: createWorktreeOperations(),
					createPane: () => pane,
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					startAgent: () => {
						throw new Error(expectedError);
					},
					closePane(surface) {
						closed.push(surface);
					},
				};

				await assert.rejects(
					launchPiSubagent(launchRequest, operations),
					new RegExp(expectedError),
				);
				assert.deepEqual(closed, [pane]);
			});
		});
	}

	it("closes an owned split child rather than its stable parent on launch failure", async () => {
		await withFixture(async ({ request }) => {
			const parentPane = "parent-pane";
			const childPane = "split-child-pane";
			const closed: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: createSubagentPaneFactory(
					{ mode: "split", direction: "down", maxPerTab: 4 },
					() => {
						throw new Error("must not create a tab");
					},
					(name, direction) => {
						assert.equal(name, "Worker");
						assert.equal(direction, "down");
						return childPane;
					},
				),
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				startAgent: () => {
					throw new Error("split startAgent failed");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent(request, operations),
				/split startAgent failed/,
			);
			assert.deepEqual(closed, [childPane]);
			assert.equal(closed.includes(parentPane), false);
		});
	});

	it("closes its fresh pane when artifact preparation fails", async () => {
		await withFixture(async ({ request, root }) => {
			const blockedSessionDir = join(root, "blocked-session-dir");
			writeFileSync(blockedSessionDir, "not a directory\n");
			const closed: string[] = [];
			let paneCreated = false;
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => {
					paneCreated = true;
					return "pane-artifact-failure";
				},
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				startAgent: () => {
					throw new Error("must not run");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent(
					{
						...request,
						parent: { ...request.parent, sessionDir: blockedSessionDir },
					},
					operations,
				),
			);
			// 新 API 中 artifact 在 pane 创建之前准备,失败时 pane 尚未创建。
			assert.equal(paneCreated, false);
			assert.deepEqual(closed, []);
		});
	});

	it("does not invent pane ownership when creation fails", async () => {
		await withFixture(async ({ request }) => {
			const closed: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => {
					throw new Error("pane creation failed");
				},
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				startAgent: () => {
					throw new Error("must not run");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent(request, operations),
				/pane creation failed/,
			);
			assert.deepEqual(closed, []);
		});
	});

	it("preserves the launch error when ordinary pane cleanup fails", async () => {
		await withFixture(async ({ request }) => {
			let cleanupAttempts = 0;
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => "pane-cleanup-error",
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				startAgent: () => {
					throw new Error("original launch error");
				},
				async closePane() {
					cleanupAttempts++;
					throw new Error("cleanup error");
				},
			};

			await assert.rejects(
				launchPiSubagent(request, operations),
				(error: Error) => error.message === "original launch error",
			);
			assert.equal(cleanupAttempts, 1);
		});
	});

	it("does not close a caller-supplied surface when launch fails", async () => {
		await withFixture(async ({ request }) => {
			const closed: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane: () => {
					throw new Error("must not create a pane");
				},
				createWorktree: () => {
					throw new Error("unexpected worktree creation");
				},
				startAgent: () => {
					throw new Error("supplied surface startAgent failed");
				},
				closePane(surface) {
					closed.push(surface);
				},
			};

			await assert.rejects(
				launchPiSubagent({ ...request, surface: "caller-pane" }, operations),
				/supplied surface startAgent failed/,
			);
			assert.deepEqual(closed, []);
		});
	});

	it("clears inherited auto-exit state for interactive children", async () => {
		await withFixture(async ({ request }) => {
			let argv: string[] = [];
			let launchEnv: Record<string, string> = {};
			await launchPiSubagent(
				{
					...request,
					behavior: {
						...request.behavior,
						autoExit: false,
						interactive: true,
					},
				},
				{
					createPane(_name, _cwd, paneEnv) {
						launchEnv = paneEnv ?? {};
						return "pane-interactive";
					},
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					startAgent(_surface, options) {
						argv = options.argv;
					},
					closePane: () => {},
				},
			);

			assert.equal(launchEnv.PI_SUBAGENT_AUTO_EXIT, "0");
			// interactive (autoExit=false) 注入 subagent_done。
			const toolsIdx = argv.indexOf("--tools");
			assert.ok(toolsIdx >= 0);
			assert.equal(argv[toolsIdx + 1], "read,bash,caller_ping,subagent_done");
		});
	});

	it("does not seed or inherit context when fork is explicitly false", async () => {
		await withFixture(async ({ request, project }) => {
			writeFileSync(
				request.parent.sessionFile,
				[
					{ type: "session", version: 3, id: "parent", cwd: project },
					{
						type: "message",
						id: "u1",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "secret context" }],
							timestamp: 1,
						},
					},
				]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			let argv: string[] = [];
			const running = await launchPiSubagent(
				{
					...request,
					fork: false,
					behavior: {
						...request.behavior,
						sessionMode: "fork",
					},
				},
				{
					createPane: () => "pane-no-fork",
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					startAgent(_surface, options) {
						argv = options.argv;
					},
					closePane: () => {},
				},
			);

			assert.equal(
				existsSync(running.sessionFile),
				false,
				"fork: false must not seed parent conversation into child session",
			);
			// fork:false 走 artifact 投递,argv 末尾是 @task.md。
			const lastArg = argv[argv.length - 1];
			assert.ok(
				lastArg.startsWith("@") && lastArg.endsWith(".md"),
				"expected artifact-backed task delivery, not direct",
			);
		});
	});

	it("seeds context and uses direct delivery when fork is omitted and sessionMode is fork", async () => {
		await withFixture(async ({ request, project }) => {
			const timestamp = new Date().toISOString();
			writeFileSync(
				request.parent.sessionFile,
				[
					{
						type: "session",
						version: 3,
						id: "parent",
						timestamp,
						cwd: project,
					},
					{
						type: "model_change",
						id: "mc-1",
						parentId: null,
						timestamp,
					},
					{
						type: "message",
						id: "u1",
						parentId: "mc-1",
						timestamp,
						message: {
							role: "user",
							content: [{ type: "text", text: "inherited context" }],
							timestamp: 1,
						},
					},
				]
					.map((e) => JSON.stringify(e))
					.join("\n") + "\n",
			);
			let argv: string[] = [];
			let launchEnv: Record<string, string> = {};
			const running = await launchPiSubagent(
				{
					...request,
					behavior: {
						...request.behavior,
						sessionMode: "fork",
					},
				},
				{
					createPane(_name, _cwd, paneEnv) {
						launchEnv = paneEnv ?? {};
						return "pane-inherited-fork";
					},
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					startAgent(_surface, options) {
						argv = options.argv;
					},
					closePane: () => {},
				},
			);

			assert.equal(
				existsSync(running.sessionFile),
				true,
				"omitted fork with sessionMode fork must seed the child session",
			);
			const childSession = readFileSync(running.sessionFile, "utf8");
			assert.match(
				childSession,
				/parentSession/,
				"child session must link to parent",
			);
			// fork 模式使用 direct 投递,argv 末尾是任务文本本身,而非 @task.md。
			const lastArg = argv[argv.length - 1];
			assert.ok(!lastArg.startsWith("@"), "fork mode must use direct delivery");
			// forked children receive the same child-context hint as standalone children.
			assert.equal(launchEnv.PI_SUBAGENT_ID, "child-1");
		});
	});

	it("keeps an autonomous multi-wave coordinator open for completion steers", async () => {
		await withFixture(async ({ request }) => {
			let argv: string[] = [];
			let launchEnv: Record<string, string> = {};
			const running = await launchPiSubagent(
				{
					...request,
					name: "Coordinator",
					agent: "test-coordinator",
					behavior: {
						...request.behavior,
						tools: "read,bash,grep,find,ls",
						autoExit: false,
						interactive: false,
					},
				},
				{
					createPane(_name, _cwd, paneEnv) {
						launchEnv = paneEnv ?? {};
						return "pane-coordinator";
					},
					createWorktree: () => {
						throw new Error("unexpected worktree creation");
					},
					startAgent(_surface, options) {
						argv = options.argv;
					},
					closePane: () => {},
				},
			);

			assert.equal(running.interactive, false);
			assert.equal(launchEnv.PI_SUBAGENT_AUTO_EXIT, "0");
			const toolsIdx = argv.indexOf("--tools");
			assert.ok(toolsIdx >= 0);
			assert.equal(
				argv[toolsIdx + 1],
				"read,bash,grep,find,ls,caller_ping,subagent_done",
			);
			// coordinator 使用 artifact 投递。
			const lastArg = argv[argv.length - 1];
			assert.ok(
				lastArg.startsWith("@") && lastArg.endsWith(".md"),
				"expected artifact-backed coordinator task",
			);
			const taskPath = lastArg.slice(1);
			assert.match(
				readFileSync(taskPath, "utf8"),
				/call the subagent_done tool/i,
			);
		});
	});

	it("resumes a session through the launch transaction", async () => {
		await withFixture(async ({ root, project, sessionDir }) => {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "child", cwd: project }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = join(root, "isolated-agent");
			try {
				const events: string[] = [];
				const closed: string[] = [];
				let argv: string[] = [];
				let launchEnv: Record<string, string> = {};
				const request: ResumePiLaunchRequest = {
					kind: "resume",
					id: "resume-1",
					name: "Resume worker",
					sessionFile,
					message: "Use the approved schema.",
					parent: { sessionId: "parent", sessionDir },
				};
				const operations: PiLaunchOperations = {
					worktree: createWorktreeOperations(),
					createPane(name, cwd, paneEnv) {
						assert.equal(name, "Resume worker");
						assert.equal(cwd, project);
						launchEnv = paneEnv ?? {};
						events.push("create");
						return "pane-resume";
					},
					createWorktree() {
						throw new Error("a resume must not create a worktree");
					},
					startAgent(surface, options) {
						assert.equal(surface, "pane-resume");
						events.push("start");
						argv = options.argv;
					},
					closePane(surface) {
						closed.push(surface);
					},
				};

				const running = await launchPiSubagent(request, operations);

				assert.deepEqual(events, ["create", "start"]);
				assert.deepEqual(closed, []);
				assert.equal(running.id, "resume-1");
				assert.equal(running.name, "Resume worker");
				assert.equal(running.task, "Use the approved schema.");
				assert.equal(running.surface, "pane-resume");
				assert.equal(running.sessionFile, sessionFile);
				assert.equal(running.interactive, false);
				assert.equal(running.runtimePlan, undefined);
				assert.equal(running.worktree, undefined);
				// resume 继承 PI_CODING_AGENT_DIR。
				assert.equal(
					launchEnv.PI_CODING_AGENT_DIR,
					process.env.PI_CODING_AGENT_DIR,
				);
				// pi 参数：session、扩展、tools。
				assert.equal(argv[0], "--session");
				assert.equal(argv[1], sessionFile);
				assert.equal(argv[2], "-e");
				assert.match(argv[3], /subagent-done\.ts$/);
				const toolsIdx = argv.indexOf("--tools");
				assert.ok(toolsIdx >= 0);
				assert.equal(argv[toolsIdx + 1], "read,bash,caller_ping");
				assert.equal(launchEnv.PI_SUBAGENT_NAME, "Resume worker");
				assert.equal(launchEnv.PI_SUBAGENT_SESSION, sessionFile);
				// Documented child-context hint: resumed children receive a new ID.
				assert.equal(launchEnv.PI_SUBAGENT_ID, "resume-1");
				assert.ok(launchEnv.PI_SUBAGENT_ACTIVITY_FILE);
				assert.equal(launchEnv.PI_SUBAGENT_AUTO_EXIT, "1");
				assert.equal(launchEnv.PI_DENY_TOOLS, "subagent,subagent_resume");
				// resume 不使用 --model / --thinking。
				assert.ok(!argv.includes("--model"));
				assert.ok(!argv.includes("--thinking"));
				// 后续消息走 artifact 投递。
				const lastArg = argv[argv.length - 1];
				assert.ok(
					lastArg.startsWith("@") && lastArg.endsWith(".md"),
					"expected artifact-backed follow-up message",
				);
				assert.equal(
					readFileSync(lastArg.slice(1), "utf8"),
					"Use the approved schema.",
				);
			} finally {
				if (previousAgentDir === undefined)
					delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		});
	});

	it("prompts a resumed child after readiness instead of carrying the message in argv", async () => {
		await withFixture(async ({ root, project, sessionDir }) => {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "child", cwd: project }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			const events: string[] = [];
			let argv: string[] = [];
			const request: ResumePiLaunchRequest = {
				kind: "resume",
				id: "resume-prompt",
				name: "Prompt worker",
				sessionFile,
				message: "Continue from the crash.",
				parent: { sessionId: "parent", sessionDir },
			};
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					events.push("create");
					return "pane-prompt";
				},
				startAgent(_surface, options) {
					events.push("start");
					argv = options.argv;
				},
				promptAgent(_surface, text) {
					events.push(`prompt:${text}`);
				},
				closePane() {},
			};

			const running = await launchPiSubagent(request, operations);

			// Herdr only reports readiness while the agent is idle, so the message must
			// arrive after startup instead of turning pi busy inside argv.
			assert.deepEqual(events, [
				"create",
				"start",
				"prompt:Continue from the crash.",
			]);
			assert.ok(!argv.some((arg) => arg.startsWith("@")));
			assert.equal(running.task, "Continue from the crash.");
		});
	});

	it("resumes under the absolute session path Pi will report, whatever form the caller passed", async () => {
		await withFixture(async ({ root, project, sessionDir }) => {
			const sessionFile = join(root, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "child", cwd: project }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			// Pi resolves `--session` against the pane's cwd (the session's project),
			// so the launch must pass and keep the path the caller's cwd meant.
			for (const given of [
				`${root}/./nested/../child.jsonl`,
				relative(process.cwd(), sessionFile),
			]) {
				let argv: string[] = [];
				let launchEnv: Record<string, string> = {};
				const running = await launchPiSubagent(
					{
						kind: "resume",
						name: "Resume worker",
						sessionFile: given,
						parent: { sessionId: "parent", sessionDir },
					},
					{
						createPane(_name, _cwd, paneEnv) {
							launchEnv = paneEnv ?? {};
							return "pane-resume";
						},
						createWorktree() {
							throw new Error("a resume must not create a worktree");
						},
						startAgent(_surface, options) {
							argv = options.argv;
						},
						closePane() {},
					},
				);
				assert.equal(running.sessionFile, sessionFile, given);
				// argv 中 --session 后的路径被规范化。
				assert.equal(argv[1], sessionFile, given);
				assert.equal(launchEnv.PI_SUBAGENT_SESSION, sessionFile, given);
			}
		});
	});

	it("clears inherited auto-exit state when a resumed session is interactive", async () => {
		await withFixture(async ({ root, sessionDir }) => {
			const sessionFile = join(root, "interactive.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({ type: "session", id: "resumed", cwd: root }) + "\n",
			);
			writePublicResumePolicy(sessionFile);
			const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			try {
				let argv: string[] = [];
				let launchEnv: Record<string, string> = {};
				const running = await launchPiSubagent(
					{
						kind: "resume",
						id: "resume-interactive",
						name: "Interactive resume",
						sessionFile,
						parent: { sessionId: "parent", sessionDir },
						behavior: { autoExit: false },
					},
					{
						createPane(_name, _cwd, paneEnv) {
							launchEnv = paneEnv ?? {};
							return "pane-interactive";
						},
						createWorktree: () => {
							throw new Error("a resume must not create a worktree");
						},
						startAgent(_surface, options) {
							argv = options.argv;
						},
						closePane: () => {},
					},
				);

				assert.equal(running.task, "resumed session");
				assert.equal(running.interactive, true);
				assert.equal(launchEnv.PI_SUBAGENT_AUTO_EXIT, "0");
				// 无 message 时不走 artifact 投递。
				const lastArg = argv[argv.length - 1];
				assert.ok(!lastArg.startsWith("@"), "no artifact when no message");
			} finally {
				if (previousAutoExit === undefined)
					delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
			}
		});
	});

	it("records worktree ownership before creation and targets its root pane", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: project,
				encoding: "utf8",
			}).trim();
			const worktreePath = join(root, "worker-tree");
			const worktreeRequest: FreshPiLaunchRequest = {
				...request,
				worktree: { branch: "issue/7", base: "HEAD" },
			};
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const events: string[] = [];
			const identity = {
				pid: 4321,
				startTime: "987",
				bootId: "boot",
				pidNamespace: "pid:[1]",
			};
			const captures: unknown[] = [];
			let splitSurfaceEnv: Record<string, string> = {};
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				async captureProcessIdentity(surface, expected) {
					captures.push({ surface, ...expected });
					return identity;
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					assert.equal(branch, "issue/7");
					assert.equal(base, baseSha);
					assert.equal(
						JSON.parse(readFileSync(manifestFile, "utf8")).state,
						"provisioning",
					);
					events.push("create");
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{
							cwd: project,
						},
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-1",
						paneId: "root-pane-1",
					};
				},
				splitSurface(pane, cwd, env) {
					assert.equal(pane, "root-pane-1");
					assert.equal(cwd, worktreePath);
					splitSurfaceEnv = env;
					events.push("split");
					return "root-pane-1";
				},
				startAgent(surface, options) {
					assert.equal(surface, "root-pane-1");
					events.push("start");
					argv = options.argv;
				},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			let argv: string[] = [];
			const running = await launchPiSubagent(worktreeRequest, operations);

			assert.ok(argv.includes(running.sessionFile));
			assert.deepEqual(events, ["create", "split", "start"]);
			assert.equal(running.worktree?.baseSha, baseSha);
			assert.equal(running.worktree?.path, worktreePath);
			assert.equal(running.worktree?.sessionFile, running.sessionFile);
			assert.equal(
				readSubagentSessionPolicy(running.sessionFile).owner,
				"managed-worktree",
			);
			// 新 API 通过 splitSurface 传递 cwd 与 env,不再有 cd 前缀。
			assert.equal(splitSurfaceEnv.PI_SUBAGENT_SESSION, running.sessionFile);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "running");
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.paneId, "root-pane-1");
			// The child records its own identity beside its session; the parent
			// verifies it against this run, session, and root pane at readiness.
			const processFile = `${running.sessionFile}.process.json`;
			assert.equal(running.processIdentityFile, processFile);
			assert.equal(splitSurfaceEnv.PI_SUBAGENT_PROCESS_FILE, processFile);
			assert.deepEqual(await running.processIdentityCapture, identity);
			assert.deepEqual(running.processIdentity, identity);
			assert.deepEqual(captures, [
				{
					surface: "root-pane-1",
					file: processFile,
					id: running.id,
					sessionFile: running.sessionFile,
				},
			]);
		});
	});

	it("provisions a linked checkout from its principal while preserving its base", async () => {
		await withFixture(async ({ request, project, root, sessionDir }) => {
			const { linkedCwd, linkedSha } = createLinkedGitFixture(root, project);
			const worktreePath = join(root, "linked-child");
			const worktreeRequest: FreshPiLaunchRequest = {
				...request,
				cwd: linkedCwd,
				worktree: { branch: "issue/59-fresh", base: "HEAD" },
			};
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					assert.equal(branch, "issue/59-fresh");
					assert.equal(base, linkedSha);
					const provisioning = JSON.parse(readFileSync(manifestFile, "utf8"));
					assert.equal(provisioning.sourceCwd, linkedCwd);
					assert.equal(provisioning.baseSha, linkedSha);
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{ cwd },
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-linked-fresh",
						paneId: "pane-linked-fresh",
					};
				},
				splitSurface(pane, cwd, _env) {
					assert.equal(pane, "pane-linked-fresh");
					assert.equal(cwd, worktreePath);
					return "pane-linked-fresh";
				},
				startAgent() {},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			const running = await launchPiSubagent(worktreeRequest, operations);

			// Without a capture operation the identity is never guessed.
			assert.equal(running.processIdentity, undefined);
			assert.equal(running.processIdentityCapture, undefined);
			assert.equal(
				running.processIdentityError,
				"process identity capture is unavailable",
			);
			assert.equal(running.worktree?.baseSha, linkedSha);
			assert.equal(running.worktree?.path, worktreePath);
			assert.equal(
				readFileSync(join(worktreePath, "linked.txt"), "utf8"),
				"linked\n",
			);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.sourceCwd, linkedCwd);
			assert.equal(manifest.baseSha, linkedSha);
		});
	});

	it("uses the principal checkout for linked worktree handoffs", async () => {
		await withFixture(async ({ request, project, root, sessionDir }) => {
			const { linked, linkedCwd, linkedSha } = createLinkedGitFixture(
				root,
				project,
			);
			writeFileSync(
				request.parent.sessionFile,
				[
					{
						type: "session",
						version: 3,
						id: "parent",
						cwd: linked,
					},
					{
						type: "message",
						id: "user-1",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "Start the feature" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "assistant-1",
						parentId: "user-1",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Continue" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			const worktreePath = join(root, "linked-handoff-child");
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Handoff");
					assert.equal(cwd, project);
					assert.equal(branch, "handoff/59");
					assert.equal(base, linkedSha);
					assert.equal(
						JSON.parse(readFileSync(manifestFile, "utf8")).sourceCwd,
						linkedCwd,
					);
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{ cwd },
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-linked-handoff",
						paneId: "pane-linked-handoff",
					};
				},
				splitSurface(pane, cwd, _env) {
					assert.equal(pane, "pane-linked-handoff");
					assert.equal(cwd, worktreePath);
					return "pane-linked-handoff";
				},
				startAgent() {},
				focusWorkspace(workspaceId) {
					assert.equal(workspaceId, "workspace-linked-handoff");
				},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			const result = await launchPiWorktreeHandoff(
				{
					...request,
					name: "Handoff",
					cwd: linkedCwd,
					worktree: { branch: "handoff/59" },
					handoff: { leafId: "assistant-1" },
				},
				operations,
			);

			assert.equal(result.running.worktree?.baseSha, linkedSha);
			assert.equal(result.running.worktree?.path, worktreePath);
			assert.equal(
				readFileSync(join(worktreePath, "linked.txt"), "utf8"),
				"linked\n",
			);
			assert.equal(
				JSON.parse(readFileSync(manifestFile, "utf8")).sourceCwd,
				linkedCwd,
			);
		});
	});

	it("forks the active conversation and focuses after launch", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			const timestamp = new Date().toISOString();
			writeFileSync(
				request.parent.sessionFile,
				[
					{
						type: "session",
						version: 3,
						id: "parent",
						timestamp,
						cwd: project,
					},
					{
						type: "message",
						id: "user-1",
						parentId: null,
						timestamp,
						message: {
							role: "user",
							content: [{ type: "text", text: "Start the feature" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "assistant-1",
						parentId: "user-1",
						timestamp,
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Continue" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			const parentBefore = readFileSync(request.parent.sessionFile, "utf8");
			const worktreePath = join(root, "handoff-tree");
			const events: string[] = [];
			let splitSurfaceEnv: Record<string, string> = {};
			let argv: string[] = [];
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(_name, cwd, branch, base) {
					assert.equal(cwd, project);
					assert.equal(branch, "handoff/feature");
					assert.equal(
						base,
						execFileSync("git", ["rev-parse", "HEAD"], {
							cwd,
							encoding: "utf8",
						}).trim(),
					);
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{ cwd },
					);
					events.push("create");
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-handoff",
						paneId: "pane-handoff",
					};
				},
				splitSurface(pane, cwd, env) {
					assert.equal(pane, "pane-handoff");
					assert.equal(cwd, worktreePath);
					splitSurfaceEnv = env;
					events.push("split");
					return "pane-handoff";
				},
				startAgent(surface, options) {
					assert.equal(surface, "pane-handoff");
					argv = options.argv;
					events.push("start");
				},
				focusWorkspace(workspaceId) {
					assert.equal(workspaceId, "workspace-handoff");
					events.push("focus");
				},
				closePane: () => {
					throw new Error("must retain the worktree workspace");
				},
			};

			const result = await launchPiWorktreeHandoff(
				{
					...request,
					name: "Handoff",
					worktree: { branch: "handoff/feature" },
					handoff: { leafId: "assistant-1" },
				},
				operations,
			);

			assert.deepEqual(events, ["create", "split", "start", "focus"]);
			assert.equal(result.focusError, undefined);
			assert.equal(
				readFileSync(request.parent.sessionFile, "utf8"),
				parentBefore,
			);
			// Handoff 通过 splitSurface 传递 env,session 文件路径在 env 中。
			assert.equal(
				splitSurfaceEnv.PI_SUBAGENT_SESSION,
				result.running.sessionFile,
			);
			// A user-driven worktree handoff is a normal interactive Pi session,
			// not a subagent: it loads no child-protocol extension.
			assert.ok(!argv.some((arg) => arg.includes("subagent-done")));
			assert.doesNotMatch(argv.join(" "), /Implement the bounded change/);
			const child = JSON.parse(
				readFileSync(result.running.sessionFile, "utf8").split("\n")[0],
			);
			assert.equal(child.cwd, worktreePath);
			const childText = readFileSync(result.running.sessionFile, "utf8");
			assert.match(childText, /pi-herdr-worktree-handoff/);
			assert.match(childText, /handoff\/feature/);
			assert.match(childText, /Implement the bounded change\./);
			assert.equal(
				readFileSync(join(worktreePath, "base.txt"), "utf8"),
				"base\n",
			);
			assert.ok(sessionDir);
		});
	});

	it("retains an explicit failed worktree handoff when process start fails", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: project,
			});
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			// handoff session
			writeFileSync(
				request.parent.sessionFile,
				[
					{ type: "session", version: 3, id: "parent", cwd: project },
					{
						type: "message",
						id: "failure-user",
						parentId: null,
						message: {
							role: "user",
							content: [{ type: "text", text: "start" }],
							timestamp: 1,
						},
					},
					{
						type: "message",
						id: "failure-assistant",
						parentId: "failure-user",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ready" }],
							api: "test",
							provider: "fake",
							model: "worker",
							usage: {},
							stopReason: "stop",
							timestamp: 2,
						},
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n") + "\n",
			);
			const parentBefore = readFileSync(request.parent.sessionFile, "utf8");
			const worktreePath = join(root, "failed-tree");
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const operations: PiLaunchOperations = {
				worktree: createWorktreeOperations(),
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(_name, cwd, branch, base) {
					execFileSync(
						"git",
						["worktree", "add", "-q", "-b", branch, worktreePath, base],
						{
							cwd,
						},
					);
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-failed",
						paneId: "root-pane-failed",
					};
				},
				splitSurface(_pane, _cwd, _env) {
					return "root-pane-failed";
				},
				startAgent() {
					throw new Error("pane rejected command");
				},
				focusWorkspace() {
					throw new Error("focus must not run after launch failure");
				},
				closePane() {
					throw new Error("must retain the worktree workspace");
				},
			};

			await assert.rejects(
				launchPiWorktreeHandoff(
					{
						...request,
						worktree: { branch: "issue/7-failed" },
						handoff: { leafId: "failure-assistant" },
					},
					operations,
				),
				/worktree retained.*pane rejected command/i,
			);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, worktreePath);
			assert.equal(manifest.sourceSessionFile, request.parent.sessionFile);
			assert.match(manifest.handoffMessage, /issue\/7-failed/);
			assert.equal(manifest.clean, true);
			assert.equal(existsSync(worktreePath), true);
			assert.equal(existsSync(manifest.sessionFile), true);
			assert.match(
				readFileSync(manifest.sessionFile, "utf8"),
				/pi-herdr-worktree-handoff/,
			);
			assert.equal(
				readFileSync(request.parent.sessionFile, "utf8"),
				parentBefore,
			);
		});
	});
});
