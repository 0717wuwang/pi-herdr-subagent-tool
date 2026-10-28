import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getSubagentActivityFile } from "./activity-file.ts";
import {
	createLifecycle,
	type SubagentLifecycle,
} from "../../core/lifecycle.ts";
import type { ResolvedRuntimePlan } from "../../core/routing.ts";
import type { PaneConfig } from "../../core/config/pane-config.ts";
import { isNonEmptyString } from "../../core/config/type-guards.ts";
import type {
	SurfaceProvider,
	WorktreeSurface,
	SurfaceEnvironment,
} from "../../core/surface-provider.ts";
import { WorktreeProvisioningError } from "../../core/surface-provider.ts";
import type {
	FailedWorktreeManifest,
	WorktreeLaunch,
	WorktreeOperations,
} from "../../core/worktree.ts";
import {
	getSubagentProcessIdentityFile,
	linuxProcessProbe,
	readProcessIdentityRecord,
	verifyProcessIdentityRecord,
	type PiProcessIdentity,
	type ProcessIdentityProbe,
} from "./process-identity.ts";
import {
	createWorktreeSessionFork,
	getNewEntries,
	readSubagentSessionPolicy,
	seedSubagentSessionFile,
	writeSubagentSessionPolicy,
} from "./session.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface FreshPiLaunchRequest {
	kind: "fresh";
	id?: string;
	name: string;
	task: string;
	agent?: string;
	cwd?: string;
	worktree?: { branch: string; base?: string } | null;
	fork?: boolean;
	handoff?: { leafId: string };
	surface?: string;
	parent: {
		cwd: string;
		invocationCwd?: string;
		sessionFile: string;
		sessionId: string;
		sessionDir: string;
		agentDir?: string;
	};
	runtimePlan: ResolvedRuntimePlan;
	behavior: {
		tools?: string;
		skills?: string;
		deniedTools: readonly string[];
		autoExit: boolean;
		interactive: boolean;
		persistent?: boolean;
		logicalId?: string;
		generationId?: string;
		taskId?: string;
		identity?: string;
		systemPromptMode?: "append" | "replace";
		sessionMode: SubagentSessionMode;
		cwd?: string;
	};
}

export interface ResumePiLaunchRequest {
	kind: "resume";
	id?: string;
	name: string;
	sessionFile: string;
	message?: string;
	parent: {
		sessionId: string;
		sessionDir: string;
	};
	behavior?: {
		autoExit?: boolean;
		interactive?: boolean;
	};
}

export type PiLaunchRequest = FreshPiLaunchRequest | ResumePiLaunchRequest;

export interface PiRunningChild {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	activityFile: string;
	interactive: boolean;
	runtimePlan: ResolvedRuntimePlan | undefined;
	worktree?: WorktreeLaunch;
	lifecycle: SubagentLifecycle;
	persistent?: boolean;
	logicalId?: string;
	generationId?: string;
	policyHash?: string;
	policyTools?: string[] | null;
	policyDeniedTools?: string[];
	tasksCompleted?: number;
	taskId?: string;
	inboxSequence?: number;
	observedTaskEvents?: number;
	stopState?: "requested" | "pending" | "failed";
	stopFailure?: string;
	crashNotified?: boolean;
	/** Managed worktree children: where the child records its own process identity. */
	processIdentityFile?: string;
	/** Verified at launch readiness; a worktree cancel's only signal and exit evidence. */
	processIdentity?: PiProcessIdentity;
	/** Settles when launch-readiness capture verifies or gives up; never rejects. */
	processIdentityCapture?: Promise<PiProcessIdentity | undefined>;
	processIdentityError?: string;
}

/** What a captured identity must match: this run, its session, and its pane. */
export interface ProcessIdentityExpectation {
	file: string;
	id: string;
	sessionFile: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface WorktreeSurfaceForLaunch {
	path: string;
	branch: string;
	workspaceId: string;
	paneId: string;
	diagnostics?: string[];
}

export interface PiLaunchOperations {
	/** Required for managed worktree launches; ordinary panes need no Git effects. */
	worktree?: WorktreeOperations;
	createPane(
		name: string,
		cwd?: string,
		env?: Record<string, string>,
	): MaybePromise<string>;
	/** Replace a surface so it carries launch variables; Herdr's `worktree create` cannot. */
	splitSurface(
		pane: string,
		cwd: string,
		env: Record<string, string>,
	): MaybePromise<string>;
	createWorktree(
		name: string,
		cwd: string,
		branch: string,
		base: string,
	): MaybePromise<WorktreeSurfaceForLaunch>;
	/**
	 * Launch the child agent in the pane through the provider's own launcher,
	 * which resolves only once the agent is interactive.
	 */
	startAgent(
		surface: string,
		options: { name: string; kind: string; argv: string[] },
	): MaybePromise<void>;
	closePane(pane: string): MaybePromise<void>;
	focusWorkspace?(workspaceId: string): MaybePromise<void>;
	/** Bounded readiness capture of a worktree child's verified process identity. */
	captureProcessIdentity?(
		surface: string,
		expected: ProcessIdentityExpectation,
		options?: { timeoutMs?: number },
	): Promise<PiProcessIdentity>;
}

function placementFromPaneConfig(config: PaneConfig) {
	if (config.mode === "split") {
		return { kind: "split" as const, direction: config.direction };
	}
	if (config.mode === "tab") return { kind: "tab" as const };
	return { kind: "grouped" as const };
}

function worktreeSurfaceForLaunch(
	worktree: WorktreeSurface,
): WorktreeSurfaceForLaunch {
	const surface: WorktreeSurfaceForLaunch = {
		path: worktree.path,
		branch: worktree.branch,
		workspaceId: worktree.workspaceId,
		paneId: worktree.surfaceId,
	};
	if (worktree.diagnostics?.length) surface.diagnostics = worktree.diagnostics;
	return surface;
}

/**
 * Names the launched session in the Pi process's exec-time environment. Pi
 * rewrites its command line, so `--session` is never readiness evidence.
 * Nothing inside Pi reads it.
 */

/**
 * Wait for the child to publish its own identity, then accept it only while
 * that process is alive in this host's namespace as the Herdr pane shell or a
 * descendant of it. Command-line text is never consulted: Pi rewrites it.
 */
export async function captureSurfacePiProcessIdentity(
	provider: Pick<SurfaceProvider, "getProcessInfo">,
	surface: string,
	expected: ProcessIdentityExpectation,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		probe?: ProcessIdentityProbe;
	} = {},
): Promise<PiProcessIdentity> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const intervalMs = options.intervalMs ?? 100;
	const deadline = Date.now() + timeoutMs;
	let lastError = "the child has not recorded its process identity";
	let answered = false;
	for (;;) {
		try {
			const record = readProcessIdentityRecord(expected.file);
			if (record) {
				// The deadline bounds Herdr too; a late answer is dropped, never accepted.
				const info = await settleBefore(
					Promise.resolve().then(() => provider.getProcessInfo(surface)),
					deadline,
					{ unref: true },
				);
				if (!info) {
					// The deadline passed; an earlier answer's refusal says more.
					if (!answered)
						lastError = `Herdr process info for pane ${surface} timed out`;
					break;
				}
				answered = true;
				if (info.shellPid === undefined)
					throw new Error(`Herdr reports no shell for pane ${surface}`);
				return verifyProcessIdentityRecord(
					record,
					{ ...expected, shellPid: info.shellPid },
					options.probe ?? linuxProcessProbe,
				);
			}
		} catch (error) {
			lastError = errorMessage(error);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		// Background capture must never hold the parent process open.
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, remaining)).unref(),
		);
	}
	throw new Error(
		`Process identity not captured within ${timeoutMs}ms: ${lastError}`,
	);
}

/**
 * The pending value if it settles before the deadline; otherwise undefined.
 * A value that arrives after the deadline is dropped, never reported, even
 * when a delayed event loop runs it before the overdue timer.
 */
export async function settleBefore<T>(
	pending: Promise<T> | undefined,
	deadline: number,
	options: { unref?: boolean } = {},
): Promise<T | undefined> {
	if (!pending) return undefined;
	let expire!: () => void;
	const expired = new Promise<undefined>((resolve) => {
		expire = () => resolve(undefined);
	});
	const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
	if (options.unref) timer.unref();
	try {
		const onTime = pending.then((value) =>
			Date.now() > deadline ? undefined : value,
		);
		return await Promise.race([onTime, expired]);
	} finally {
		clearTimeout(timer);
	}
}

export function launchOperationsFromSurface(
	provider: SurfaceProvider,
	config: PaneConfig,
	worktree?: WorktreeOperations,
): PiLaunchOperations {
	return {
		worktree,
		createPane(name, cwd, env) {
			return provider.createSurface({
				name,
				cwd: cwd ?? process.cwd(),
				placement: placementFromPaneConfig(config),
				env,
			});
		},
		async createWorktree(name, cwd, branch, base) {
			const worktree = await Promise.resolve(
				provider.createWorktreeSurface({ name, cwd, branch, base }),
			);
			return worktreeSurfaceForLaunch(worktree);
		},
		startAgent(surface, options) {
			return provider.startAgent(surface, options);
		},
		splitSurface(pane, cwd, env) {
			return provider.splitSurface(pane, { cwd, env });
		},
		closePane(pane) {
			return provider.closeSurface(pane);
		},
		focusWorkspace(workspaceId) {
			return provider.focusWorkspace(workspaceId);
		},
		captureProcessIdentity(surface, expected, options) {
			return captureSurfacePiProcessIdentity(
				provider,
				surface,
				expected,
				options,
			);
		},
	};
}

interface ResolvedLaunch {
	request: FreshPiLaunchRequest;
	id: string;
	startTime: number;
	agentDir: string;
	localAgentDir: string | null;
	sourceCwd: string;
	artifactDir: string;
	sessionMode: SubagentSessionMode;
	taskDelivery: "direct" | "artifact";
}

/** Everything resolvable before the pane exists: the checkout and agent dirs. */
interface PreparedTarget {
	targetCwd: string;
	effectiveAgentDir: string;
	localAgentDir: string | null;
	worktree?: WorktreeLaunch;
}

interface PreparedSession extends PreparedTarget {
	sessionFile: string;
	activityFile: string;
	processIdentityFile?: string;
}

interface PreparedArtifacts extends PreparedSession {
	surface: string;
	taskArg: string;
	systemPromptFile?: string;
}

/**
 * Launch one validated Pi-backed request. Lifecycle watching and parent
 * delivery begin only after this transaction returns the running child.
 */
export async function launchPiSubagent(
	request: PiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	return request.kind === "resume"
		? launchResumedPiSubagent(request, operations)
		: launchFreshPiSubagent(request, operations);
}

export async function launchPiWorktreeHandoff(
	request: FreshPiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<{ running: PiRunningChild; focusError?: string }> {
	if (!request.worktree || !request.handoff) {
		throw new Error("A worktree handoff requires a worktree and active leaf");
	}
	const running = await launchPiSubagent(request, operations);
	if (!running.worktree) {
		throw new Error("Worktree handoff did not create a managed worktree");
	}
	try {
		await operations.focusWorkspace?.(running.worktree.workspaceId);
	} catch (error) {
		const focusError = errorMessage(error);
		requireWorktreeOperations(operations).writeWorktreeManifest(
			running.worktree.manifestFile,
			{
				state: "running",
				focusError,
			},
		);
		return {
			running,
			focusError,
		};
	}
	return { running };
}

async function launchFreshPiSubagent(
	request: FreshPiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	const resolved = resolveLaunchRequest(request);
	let target: PreparedTarget | undefined;
	let surface: string | undefined;

	try {
		target = await prepareLaunchTarget(resolved, operations);
		const session = prepareChildSession(resolved, target, operations);
		const artifacts = prepareTaskArtifacts(resolved, session, operations);
		surface = await attachLaunchSurface(resolved, target, session, operations);
		const launched: PreparedArtifacts = { ...artifacts, surface };
		await startPiAgent(resolved, operations, launched);
		const running = createRunningChild(resolved, launched);
		startProcessIdentityCapture(running, operations);
		return running;
	} catch (error) {
		if (!target) throw error;
		if (!target.worktree) {
			if (!request.surface) {
				try {
					if (surface) await operations.closePane(surface);
				} catch {
					// The launch error remains authoritative when cleanup also fails.
				}
			}
			throw error;
		}
		const worktreeOps = requireWorktreeOperations(operations);
		const handoff = worktreeOps.captureWorktreeHandoff(target.worktree);
		try {
			worktreeOps.persistWorktreeResult(target.worktree, "failed", handoff);
		} catch {
			// The launch error remains authoritative when persistence also fails.
		}
		throw new Error(
			`Failed to launch subagent; worktree retained at ${target.worktree.path} ` +
				`(workspace ${target.worktree.workspaceId}): ${errorMessage(error)}`,
		);
	}
}

function resolveLaunchRequest(request: FreshPiLaunchRequest): ResolvedLaunch {
	const id = request.id ?? Math.random().toString(16).slice(2, 10);
	const agentDir =
		request.parent.agentDir ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent");
	const rawCwd = request.cwd ?? request.behavior.cwd;
	const cwdBase =
		request.cwd == null && request.behavior.cwd != null
			? agentDir
			: (request.parent.invocationCwd ?? request.parent.cwd);
	const sourceCwd = rawCwd
		? rawCwd.startsWith("/")
			? rawCwd
			: join(cwdBase, rawCwd)
		: request.parent.cwd;
	const localAgentDir = rawCwd ? join(sourceCwd, ".pi", "agent") : null;
	let sessionMode: SubagentSessionMode = request.behavior.sessionMode;
	if (request.fork === true) sessionMode = "fork";
	else if (request.fork === false) sessionMode = "standalone";
	return {
		request,
		id,
		startTime: Date.now(),
		agentDir,
		localAgentDir:
			localAgentDir && existsSync(localAgentDir) ? localAgentDir : null,
		sourceCwd,
		artifactDir: join(
			request.parent.sessionDir,
			"artifacts",
			request.parent.sessionId,
		),
		sessionMode,
		taskDelivery: sessionMode === "fork" ? "direct" : "artifact",
	};
}

async function prepareLaunchTarget(
	resolved: ResolvedLaunch,
	operations: PiLaunchOperations,
): Promise<PreparedTarget> {
	const { request } = resolved;
	if (!request.worktree) {
		return {
			targetCwd: resolved.sourceCwd,
			effectiveAgentDir: resolved.localAgentDir ?? resolved.agentDir,
			localAgentDir: resolved.localAgentDir,
		};
	}
	if (request.surface)
		throw new Error("A worktree subagent cannot use a pre-created pane");

	const worktreeOps = requireWorktreeOperations(operations);
	const baseRef = request.worktree.base ?? "HEAD";
	const baseSha = worktreeOps.resolveGitCommit(resolved.sourceCwd, baseRef);
	const provisionCwd = worktreeOps.resolveWorktreeProvisionCwd(
		resolved.sourceCwd,
	);
	const manifestFile = join(
		resolved.artifactDir,
		"worktree-runs",
		`${resolved.id}.json`,
	);
	const ownership = {
		id: resolved.id,
		name: request.name,
		sourceCwd: resolved.sourceCwd,
		branch: request.worktree.branch,
		baseRef,
		baseSha,
		createdAt: resolved.startTime,
	};
	worktreeOps.writeWorktreeManifest(manifestFile, {
		state: "provisioning",
		...ownership,
	});

	let created: WorktreeSurfaceForLaunch;
	try {
		created = await operations.createWorktree(
			request.name,
			provisionCwd,
			request.worktree.branch,
			baseSha,
		);
	} catch (error) {
		const failedManifest: FailedWorktreeManifest = {
			state: "failed",
			...ownership,
		};
		if (error instanceof WorktreeProvisioningError) {
			Object.assign(failedManifest, error.recoveredWorktree);
		}
		failedManifest.error = errorMessage(error);
		worktreeOps.writeWorktreeManifest(manifestFile, failedManifest);
		throw error;
	}

	const worktree: WorktreeLaunch = {
		path: created.path,
		workspaceId: created.workspaceId,
		paneId: created.paneId,
		branch: created.branch,
		baseRef,
		baseSha,
		manifestFile,
	};
	if (created.diagnostics?.length) worktree.diagnostics = created.diagnostics;
	worktreeOps.writeWorktreeManifest(manifestFile, {
		state: "provisioned",
		...ownership,
		...worktree,
	});
	const isolatedAgentDir = join(created.path, ".pi", "agent");
	const hasIsolatedAgentDir = existsSync(isolatedAgentDir);
	return {
		targetCwd: created.path,
		effectiveAgentDir: hasIsolatedAgentDir
			? isolatedAgentDir
			: resolved.agentDir,
		localAgentDir: hasIsolatedAgentDir ? isolatedAgentDir : null,
		worktree,
	};
}

/**
 * Adopt or create the pane carrying the child's launch variables. Every
 * variable is derived before this runs, so none of them names the pane.
 */
async function attachLaunchSurface(
	resolved: ResolvedLaunch,
	target: PreparedTarget,
	session: PreparedSession,
	operations: PiLaunchOperations,
): Promise<string> {
	const { request } = resolved;
	if (request.surface) return request.surface;
	const env = buildLaunchEnv(resolved, session);
	if (target.worktree) {
		// `worktree create` cannot pass variables, so the pane it opened is
		// replaced in its own workspace and discarded.
		const worktreeOps = requireWorktreeOperations(operations);
		const surface = await operations.splitSurface(
			target.worktree.paneId,
			target.targetCwd,
			env,
		);
		target.worktree.paneId = surface;
		worktreeOps.writeWorktreeManifest(target.worktree.manifestFile, {
			paneId: surface,
		});
		return surface;
	}
	return operations.createPane(request.name, target.targetCwd, env);
}

function prepareChildSession(
	resolved: ResolvedLaunch,
	surface: PreparedTarget,
	operations: PiLaunchOperations,
): PreparedSession {
	const sessionDir = getDefaultSessionDirFor(
		surface.targetCwd,
		surface.effectiveAgentDir,
	);
	const timestamp = timestampForFile();
	const uuid = [
		resolved.id,
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	const sessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
	if (surface.worktree) {
		surface.worktree.sessionFile = sessionFile;
		requireWorktreeOperations(operations).writeWorktreeManifest(
			surface.worktree.manifestFile,
			{ sessionFile },
		);
	}
	writeSubagentSessionPolicy(sessionFile, {
		owner: surface.worktree ? "managed-worktree" : "public",
		tools: resolved.request.behavior.tools,
		deniedTools: resolved.request.behavior.deniedTools,
		persistent: resolved.request.behavior.persistent,
		logicalId: resolved.request.behavior.logicalId ?? resolved.id,
		generationId: resolved.request.behavior.generationId,
		worktree: surface.worktree
			? {
					path: surface.worktree.path,
					workspaceId: surface.worktree.workspaceId,
					branch: surface.worktree.branch,
					baseSha: surface.worktree.baseSha,
				}
			: undefined,
	});
	const activityFile = getSubagentActivityFile(
		resolved.artifactDir,
		resolved.id,
	);
	return {
		...surface,
		sessionFile,
		activityFile,
		// A handoff Pi loads no child protocol extension, so it records nothing.
		processIdentityFile:
			surface.worktree && !resolved.request.handoff
				? getSubagentProcessIdentityFile(sessionFile)
				: undefined,
	};
}

function buildWorktreeHandoffMessage(
	request: FreshPiLaunchRequest,
	worktree: WorktreeLaunch,
	sessionFile: string,
): string {
	const task = request.task.slice(0, 2000);
	return [
		"Worktree handoff context:",
		`Branch: ${worktree.branch}`,
		`Base commit: ${worktree.baseSha}`,
		`Worktree: ${worktree.path}`,
		`Source session: ${request.parent.sessionFile}`,
		`Fork session: ${sessionFile}`,
		"",
		"Requested task:",
		task || "Continue the current work in this worktree.",
	].join("\n");
}

function prepareTaskArtifacts(
	resolved: ResolvedLaunch,
	session: PreparedSession,
	operations: PiLaunchOperations,
): Omit<PreparedArtifacts, "surface"> {
	const { request } = resolved;
	if (request.handoff) {
		if (!session.worktree) {
			throw new Error("A worktree handoff requires a managed worktree");
		}
		const handoffMessage = buildWorktreeHandoffMessage(
			request,
			session.worktree,
			session.sessionFile,
		);
		createWorktreeSessionFork({
			parentSessionFile: request.parent.sessionFile,
			leafId: request.handoff.leafId,
			childSessionFile: session.sessionFile,
			childCwd: session.targetCwd,
			handoffMessage,
		});
		session.worktree.sourceSessionFile = request.parent.sessionFile;
		session.worktree.handoffMessage = handoffMessage;
		requireWorktreeOperations(operations).writeWorktreeManifest(
			session.worktree.manifestFile,
			{
				sourceSessionFile: request.parent.sessionFile,
				handoffMessage,
			},
		);
	} else if (resolved.sessionMode !== "standalone") {
		seedSubagentSessionFile({
			mode: resolved.sessionMode,
			parentSessionFile: request.parent.sessionFile,
			childSessionFile: session.sessionFile,
			childCwd: session.targetCwd,
		});
	}
	mkdirSync(dirname(session.activityFile), { recursive: true });

	const identityInSystemPrompt =
		request.behavior.systemPromptMode && request.behavior.identity;
	const roleBlock =
		request.behavior.identity && !identityInSystemPrompt
			? `\n\n${request.behavior.identity}`
			: "";
	const modeHint = request.behavior.autoExit
		? "Complete your task autonomously."
		: "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
	const summaryInstruction = request.behavior.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
	const fullTask = request.handoff
		? request.task
		: resolved.sessionMode === "fork"
			? request.task
			: `${roleBlock}\n\n${modeHint}\n\n${request.task}\n\n${summaryInstruction}`;
	let taskArg = fullTask;
	if (resolved.taskDelivery === "artifact" && !request.handoff) {
		const artifactPath = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(artifactPath), { recursive: true });
		writeFileSync(artifactPath, fullTask, "utf8");
		taskArg = `@${artifactPath}`;
	}

	let systemPromptFile: string | undefined;
	if (identityInSystemPrompt) {
		systemPromptFile = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-sysprompt-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(systemPromptFile), { recursive: true });
		writeFileSync(systemPromptFile, identityInSystemPrompt, "utf8");
	}
	return { ...session, taskArg, systemPromptFile };
}

/**
 * Variables the child reads as process environment. Built before the pane
 * exists, so every value is derivable from the request: nothing depends on the
 * pane id. `PI_SUBAGENT_SURFACE` is no longer set because nothing reads it.
 */
function buildLaunchEnv(
	resolved: ResolvedLaunch,
	session: PreparedSession,
): SurfaceEnvironment {
	const env: SurfaceEnvironment = {
		PI_DENY_TOOLS: resolved.request.behavior.deniedTools.join(","),
		PI_SUBAGENT_NAME: resolved.request.name,
		PI_SUBAGENT_AGENT: resolved.request.agent ?? "",
		PI_SUBAGENT_AUTO_EXIT: resolved.request.behavior.autoExit ? "1" : "0",
		PI_SUBAGENT_PERSISTENT: resolved.request.behavior.persistent ? "1" : "",
		PI_SUBAGENT_GENERATION_ID: resolved.request.behavior.generationId ?? "",
		PI_SUBAGENT_TASK_ID: resolved.request.behavior.taskId ?? "",
		PI_SUBAGENT_SESSION: session.sessionFile,
		PI_SUBAGENT_ID: resolved.id,
		PI_SUBAGENT_ACTIVITY_FILE: session.activityFile,
		PI_SUBAGENT_PROCESS_FILE: session.processIdentityFile ?? "",
	};
	const agentDir = session.localAgentDir ?? process.env.PI_CODING_AGENT_DIR;
	if (agentDir) {
		env.PI_CODING_AGENT_DIR = agentDir;
	}
	return env;
}

function buildPiArgv(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
): string[] {
	const behavior = resolved.request.behavior;
	const argv = [
		"--session",
		artifacts.sessionFile,
		...(!resolved.request.handoff
			? ["-e", join(SUBAGENTS_DIR, "child", "subagent-done.ts")]
			: []),
	];
	const plan = resolved.request.runtimePlan;
	if (plan.model) argv.push("--model", plan.model);
	if (plan.thinking) argv.push("--thinking", plan.thinking);
	const toolAllowlist = buildSubagentToolAllowlist(
		behavior.tools,
		behavior.autoExit,
	);
	if (toolAllowlist) argv.push("--tools", toolAllowlist);
	if (artifacts.systemPromptFile) {
		argv.push(
			behavior.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			artifacts.systemPromptFile,
		);
	}
	if (!resolved.request.handoff) {
		for (const prompt of buildPromptArgs(
			behavior.skills,
			resolved.taskDelivery,
			artifacts.taskArg,
		)) {
			argv.push(prompt);
		}
	}
	return argv;
}

async function startPiAgent(
	resolved: ResolvedLaunch,
	operations: PiLaunchOperations,
	artifacts: PreparedArtifacts,
): Promise<void> {
	await operations.startAgent(artifacts.surface, {
		name: resolved.request.name,
		kind: "pi",
		argv: buildPiArgv(resolved, artifacts),
	});
	// Herdr reports success only once the agent is able to accept input, so the
	// managed worktree is already a live checkout by this point.
	if (artifacts.worktree) {
		requireWorktreeOperations(operations).persistWorktreeResult(
			artifacts.worktree,
			"running",
		);
	}
}

function createRunningChild(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
): PiRunningChild {
	return {
		id: resolved.id,
		name: resolved.request.name,
		task: resolved.request.task,
		agent: resolved.request.agent,
		surface: artifacts.surface,
		startTime: resolved.startTime,
		sessionFile: artifacts.sessionFile,
		activityFile: artifacts.activityFile,
		interactive: resolved.request.behavior.interactive,
		runtimePlan: resolved.request.runtimePlan,
		worktree: artifacts.worktree,
		lifecycle: createLifecycle(resolved.startTime),
		processIdentityFile: artifacts.processIdentityFile,
	};
}

// Capture runs beside the launch so readiness never delays the acknowledgement;
// a cancel awaits it, and without a verified identity nothing is signalled. A
// cancel after an expired capture starts a fresh one bounded by its own budget.
export function startProcessIdentityCapture(
	child: PiRunningChild,
	operations: PiLaunchOperations,
	options?: { timeoutMs?: number },
): void {
	const file = child.processIdentityFile;
	if (!file) return;
	const capture = operations.captureProcessIdentity;
	if (!capture) {
		child.processIdentityError = "process identity capture is unavailable";
		return;
	}
	child.processIdentityError = undefined;
	child.processIdentityCapture = Promise.resolve()
		.then(() =>
			capture(
				child.surface,
				{ file, id: child.id, sessionFile: child.sessionFile },
				options,
			),
		)
		.then(
			(identity) => (child.processIdentity = identity),
			(error) => {
				child.processIdentityError = errorMessage(error);
				return undefined;
			},
		);
}

async function launchResumedPiSubagent(
	callerRequest: ResumePiLaunchRequest,
	operations: PiLaunchOperations,
): Promise<PiRunningChild> {
	const { request, id } = resolveResumeTarget(callerRequest);
	const policy = readSubagentSessionPolicy(request.sessionFile);
	assertResumablePolicy(policy, request.sessionFile);
	const autoExit = request.behavior?.autoExit ?? true;
	const interactive = request.behavior?.interactive ?? !autoExit;
	const startTime = Date.now();
	const artifactDir = join(
		request.parent.sessionDir,
		"artifacts",
		request.parent.sessionId,
	);
	const header = getNewEntries(request.sessionFile, 0).find(
		(entry) => entry.type === "session",
	);
	const cwd = isNonEmptyString(header?.cwd) ? header.cwd : process.cwd();
	const activityFile = getSubagentActivityFile(artifactDir, id);
	mkdirSync(dirname(activityFile), { recursive: true });

	// Herdr reports readiness only while the agent is idle. A message carried in argv
	// turns pi busy before the probe observes it, so resume launches time out on large
	// sessions. Providers with a prompt channel receive the message after readiness.
	const hasPromptChannel = Boolean(operations.promptAgent);
	const messageFile = writeResumeMessageFile(
		request,
		artifactDir,
		hasPromptChannel,
	);
	const env = buildResumeEnvironment(
		request,
		policy,
		id,
		activityFile,
		autoExit,
	);
	const argv = buildResumeArgv(
		request.sessionFile,
		buildSubagentToolAllowlist(policy.tools?.join(","), autoExit),
		messageFile,
	);

	const surface = await operations.createPane(request.name, cwd, env);
	try {
		await operations.startAgent(surface, {
			name: request.name,
			kind: "pi",
			argv,
		});
		if (request.message && hasPromptChannel) {
			await operations.promptAgent?.(surface, request.message);
		}
		return {
			id,
			name: request.name,
			task: request.message ?? "resumed session",
			surface,
			startTime,
			sessionFile: request.sessionFile,
			activityFile,
			interactive,
			runtimePlan: undefined,
			lifecycle: createLifecycle(startTime),
		};
	} catch (error) {
		try {
			await operations.closePane(surface);
		} catch {
			// The launch error remains authoritative when cleanup also fails.
		}
		throw error;
	}
}

/**
 * Pi resolves `--session` against the pane's cwd, not the caller's. Resolve it here
 * once, so every read, the command, and the running child's session file name the
 * same absolute path that Pi then reports to Herdr.
 */
function resolveResumeTarget(callerRequest: ResumePiLaunchRequest) {
	return {
		request: {
			...callerRequest,
			sessionFile: resolve(callerRequest.sessionFile),
		},
		id: callerRequest.id ?? Math.random().toString(16).slice(2, 10),
	};
}

/** Refuse resume targets that v1 deliberately keeps outside the public session space. */
function assertResumablePolicy(
	policy: ReturnType<typeof readSubagentSessionPolicy>,
	sessionFile: string,
): void {
	if (policy.owner !== "public") {
		throw new Error(
			`Cannot resume ${policy.owner} session through subagent_resume. ` +
				"Use its retained managed-worktree workspace instead.",
		);
	}
	if (policy.persistent) {
		throw new Error(
			`Cannot resume persistent specialist ${sessionFile}. Spawn a new specialist instead; persistent sessions retain their evidence but do not revive in v1.`,
		);
	}
}

/**
 * Hand the first message to a provider that can prompt after readiness, and fall
 * back to an `@file` argv argument only when it cannot. Resume messages are whole
 * transcripts, so the argv fallback also risks exceeding the command-length limit.
 */
function writeResumeMessageFile(
	request: ResumePiLaunchRequest,
	artifactDir: string,
	hasPromptChannel: boolean,
): string | undefined {
	if (!request.message || hasPromptChannel) return undefined;
	const messageFile = join(
		artifactDir,
		"subagent-resume",
		`${safeName(request.name) || "resume"}-${timestampForFile(false)}.md`,
	);
	mkdirSync(dirname(messageFile), { recursive: true });
	writeFileSync(messageFile, request.message, "utf8");
	return messageFile;
}

function buildResumeEnvironment(
	request: ResumePiLaunchRequest,
	policy: ReturnType<typeof readSubagentSessionPolicy>,
	id: string,
	activityFile: string,
	autoExit: boolean,
): SurfaceEnvironment {
	const env: SurfaceEnvironment = {
		PI_SUBAGENT_NAME: request.name,
		PI_SUBAGENT_SESSION: request.sessionFile,
		PI_SUBAGENT_ID: id,
		PI_SUBAGENT_ACTIVITY_FILE: activityFile,
		PI_SUBAGENT_AUTO_EXIT: autoExit ? "1" : "0",
	};
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) {
		env.PI_CODING_AGENT_DIR = agentDir;
	}
	if (policy.deniedTools.length > 0) {
		env.PI_DENY_TOOLS = policy.deniedTools.join(",");
	}
	return env;
}

function buildResumeArgv(
	sessionFile: string,
	toolAllowlist: string | null,
	messageFile: string | undefined,
): string[] {
	const argv = [
		"--session",
		sessionFile,
		"-e",
		join(SUBAGENTS_DIR, "child", "subagent-done.ts"),
	];
	if (toolAllowlist) argv.push("--tools", toolAllowlist);
	if (messageFile) argv.push(`@${messageFile}`);
	return argv;
}

export function buildSubagentToolAllowlist(
	tools?: string,
	autoExit = false,
): string | null {
	const requested = (tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (requested.length === 0) return null;
	const allow = new Set(requested);
	allow.delete("subagent_done");
	allow.add("caller_ping");
	if (!autoExit) allow.add("subagent_done");
	return [...allow].join(",");
}

function buildPromptArgs(
	skills: string | undefined,
	taskDelivery: "direct" | "artifact",
	taskArg: string,
): string[] {
	const skillPrompts = (skills ?? "")
		.split(",")
		.map((skill) => skill.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);
	return [
		...(taskDelivery === "artifact" && skillPrompts.length > 0 ? [""] : []),
		...skillPrompts,
		taskArg,
	];
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

function timestampForFile(includeMilliseconds = true): string {
	return (
		new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, includeMilliseconds ? 23 : 19) +
		(includeMilliseconds ? "Z" : "")
	);
}

function safeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function requireWorktreeOperations(
	operations: PiLaunchOperations,
): WorktreeOperations {
	if (!operations.worktree)
		throw new Error("Worktree operations are unavailable");
	return operations.worktree;
}

function errorMessage(error: any): string {
	return error instanceof Error ? error.message : String(error);
}
