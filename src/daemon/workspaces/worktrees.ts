import { realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { workspaceSchema, type Workspace } from "../../shared/domain/workspaces.ts";
import { GitService } from "./git.ts";
import type { MetadataRepositories } from "../metadata/repositories.ts";
import { MetadataGenerator, type WorktreeSuggestion } from "./metadata-generator.ts";

export class WorktreeError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
export type DiscoveredWorktree = {
  path: string;
  branchRef: string | null;
  head: string;
  isMain: boolean;
  isRegistered: boolean;
  workspaceId: string | null;
  archived: boolean;
};
const markerName = ".passage-worktree.json";
const id = () => crypto.randomUUID();
const inside = (root: string, path: string) => { const r = relative(root, path); return r === "" || (!r.split(/[\\/]/).includes("..") && !resolve(path).startsWith("..")); };

export class WorktreeService {
  constructor(
    private readonly repositories: MetadataRepositories,
    private readonly git = new GitService(),
    private readonly metadataGenerator = new MetadataGenerator(),
  ) {}

  async suggest(projectId: string, purpose: string): Promise<WorktreeSuggestion> {
    const project = this.repositories.projects.get(projectId);
    if (!project || project.archivedAt) throw new WorktreeError("invalid-project", "Active project required");
    return this.metadataGenerator.suggest(purpose, project.canonicalRootPath);
  }
  async create(projectId: string, locationId: string, ref: string, label: string, folder?: string, options?: { createBranch?: boolean; baseRef?: string }): Promise<Workspace> {
    const project = this.repositories.projects.get(projectId); if (!project || project.archivedAt) throw new WorktreeError("invalid-project", "Active project required");
    const location = this.repositories.worktreeLocations.get(locationId); if (!location || !location.enabled || (location.projectId && location.projectId !== projectId)) throw new WorktreeError("invalid-location", "An enabled worktree location is required. Configure one before creating a worktree.");
    if (!ref || ref.startsWith("-") || ref.includes("..")) throw new WorktreeError("invalid-ref", `Invalid Git ref "${ref}". Use an existing branch name, or choose "New branch" to create one.`);
    const parent = await realpath(location.canonicalRootPath); let name = (folder ?? label).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "worktree";
    let destination = join(parent, name); for (let n = 2; true; n++) { try { await realpath(destination); destination = join(parent, `${name}-${n}`); } catch { break; } }
    if (!inside(parent, destination)) throw new WorktreeError("outside-location", "Destination is outside the configured location");
    let args: string[];
    if (options?.createBranch) {
      const base = options.baseRef?.trim();
      if (!base || base.startsWith("-") || base.includes("..")) throw new WorktreeError("invalid-ref", "A valid base branch or ref is required to create a new branch.");
      if (await this.branchExists(project.canonicalRootPath, ref)) throw new WorktreeError("branch-exists", `Branch "${ref}" already exists. Use "Existing branch" mode to check it out, or pick a different name.`);
      args = ["worktree", "add", "-b", ref, destination, base];
    } else {
      if (!(await this.refExists(project.canonicalRootPath, ref))) throw new WorktreeError("ref-not-found", `Branch or ref "${ref}" was not found. Create it first, choose "New branch" mode, or pick an existing ref.`);
      args = ["worktree", "add", destination, ref];
    }
    const result = await this.command(project.canonicalRootPath, args); if (result.code !== 0) throw this.mapGitFailure(result.stderr, ref, Boolean(options?.createBranch));
    const workspaceId = `wsp_${id()}`;
    try {
      const discovered = await this.git.discover(destination);
      const workspace = workspaceSchema.parse({
        id: workspaceId,
        projectId,
        kind: "worktree",
        cwd: destination,
        checkoutRoot: discovered.checkoutRoot,
        mainRepositoryRoot: discovered.mainCheckoutRoot,
        branchRef: discovered.branchRef,
        displayLabel: label,
        locationId,
        ownershipState: "owned",
        markerId: null,
        markerPath: null,
        repairDetail: null,
        archivedAt: null,
      });
      this.repositories.workspaces.save(workspace);
      return workspace;
    } catch (error) {
      const repair = workspaceSchema.parse({
        id: workspaceId,
        projectId,
        kind: "worktree",
        cwd: destination,
        checkoutRoot: destination,
        mainRepositoryRoot: project.canonicalRootPath,
        branchRef: ref,
        displayLabel: label,
        locationId,
        ownershipState: "repair",
        markerId: null,
        markerPath: null,
        repairDetail: String(error),
        archivedAt: null,
      });
      try { this.repositories.workspaces.save(repair); } catch {}
      throw error;
    }
  }
  async reconcile(workspaceId: string): Promise<Workspace> {
    const w = this.repositories.workspaces.get(workspaceId);
    if (!w) throw new WorktreeError("not-found", "Workspace not found");
    if (w.kind !== "worktree") return workspaceSchema.parse(w);
    const project = this.repositories.projects.get(w.projectId);
    if (!project) throw new WorktreeError("invalid-project", "Active project required");
    const canonicalPath = await realpath(w.cwd).catch(() => {
      throw new WorktreeError("not-found", "Worktree directory not found");
    });
    const discovered = await this.git.discover(canonicalPath).catch(() => {
      throw new WorktreeError("invalid-git", "Not a valid Git worktree");
    });
    const projectRoot = resolve(project.canonicalRootPath);
    const gitMain = discovered.mainCheckoutRoot ? resolve(discovered.mainCheckoutRoot) : null;
    const gitRepo = resolve(discovered.repositoryRoot);
    if (gitMain !== projectRoot && gitRepo !== projectRoot) {
      throw new WorktreeError("wrong-project", "Worktree belongs to a different repository");
    }
    const fixed = workspaceSchema.parse({
      ...w,
      cwd: canonicalPath,
      checkoutRoot: discovered.checkoutRoot,
      mainRepositoryRoot: discovered.mainCheckoutRoot,
      branchRef: discovered.branchRef,
      ownershipState: "owned",
      repairDetail: null,
    });
    this.repositories.workspaces.save(fixed);
    return fixed;
  }
  async remove(workspaceId: string, force = false): Promise<void> {
    const w = this.repositories.workspaces.get(workspaceId);
    if (!w) {
      if (force) return;
      throw new WorktreeError("not-found", "Workspace not found");
    }
    if (w.kind === "main-checkout" || resolve(w.cwd) === resolve(w.mainRepositoryRoot ?? "")) {
      throw new WorktreeError("main-checkout", "Main checkout cannot be removed");
    }
    if (w.kind !== "worktree") {
      throw new WorktreeError("not-found", "Workspace not found");
    }
    if (w.ownershipState !== "owned" && !force) {
      throw new WorktreeError("not-owned", "Passage ownership record required");
    }
    if (w.markerPath) {
      await rm(w.markerPath, { force: true }).catch(() => {});
    }
    await rm(join(w.cwd, markerName), { force: true }).catch(() => {});
    const cwdExists = await realpath(w.cwd).then(() => true, () => false);
    if (!cwdExists) {
      await this.command(w.mainRepositoryRoot ?? process.cwd(), ["worktree", "prune"]).catch(() => {});
      this.repositories.workspaces.delete(workspaceId);
      return;
    }
    const status = await this.git.status(w.cwd).catch((err) => {
      if (force) return { dirty: false, conflicted: false };
      throw new WorktreeError("git-failed", err instanceof Error ? err.message : "Failed to get git status");
    });
    if ((status.dirty || status.conflicted) && !force) throw new WorktreeError("force-required", "Explicit force confirmation required");
    const result = await this.command(w.mainRepositoryRoot ?? w.cwd, ["worktree", "remove", ...(force ? ["--force"] : []), w.cwd]);
    if (result.code !== 0) {
      if (force) {
        await rm(w.cwd, { recursive: true, force: true }).catch(() => {});
        await this.command(w.mainRepositoryRoot ?? process.cwd(), ["worktree", "prune"]).catch(() => {});
      } else {
        throw this.mapGitFailure(result.stderr, w.cwd, false);
      }
    }
    this.repositories.workspaces.delete(workspaceId);
  }

  async discover(projectId: string): Promise<DiscoveredWorktree[]> {
    const project = this.repositories.projects.get(projectId);
    if (!project || project.archivedAt) throw new WorktreeError("invalid-project", "Active project required");
    const existingWorkspaces = this.repositories.workspaces.listForProject(projectId, 100, false);
    const archivedWorkspaces = this.repositories.workspaces.listForProject(projectId, 100, true);
    const allWorkspaces = [...existingWorkspaces, ...archivedWorkspaces];

    const worktreeEntries = await this.git.listWorktrees(project.canonicalRootPath);
    const discovered: DiscoveredWorktree[] = [];

    for (const entry of worktreeEntries) {
      if (entry.isBare) continue;
      const realWorktreePath = entry.path;
      const matching = allWorkspaces.find((w) => resolve(w.cwd) === resolve(realWorktreePath) || resolve(w.checkoutRoot ?? "") === resolve(realWorktreePath));
      const isMain = resolve(realWorktreePath) === resolve(project.canonicalRootPath);

      discovered.push({
        path: realWorktreePath,
        branchRef: entry.branchRef,
        head: entry.head,
        isMain,
        isRegistered: Boolean(matching && !matching.archivedAt),
        workspaceId: matching?.id ?? null,
        archived: Boolean(matching?.archivedAt),
      });
    }

    return discovered;
  }

  async importWorktree(projectId: string, input: { path: string; label?: string }): Promise<Workspace> {
    const project = this.repositories.projects.get(projectId);
    if (!project || project.archivedAt) throw new WorktreeError("invalid-project", "Active project required");
    const canonicalPath = await realpath(input.path).catch(() => {
      throw new WorktreeError("not-found", "Worktree directory not found");
    });

    const gitDiscovery = await this.git.discover(canonicalPath).catch(() => {
      throw new WorktreeError("invalid-git", "Not a valid Git worktree");
    });

    const projectRoot = resolve(project.canonicalRootPath);
    const gitMain = gitDiscovery.mainCheckoutRoot ? resolve(gitDiscovery.mainCheckoutRoot) : null;
    const gitRepo = resolve(gitDiscovery.repositoryRoot);

    if (gitMain !== projectRoot && gitRepo !== projectRoot) {
      throw new WorktreeError("wrong-project", "Worktree belongs to a different repository");
    }

    const allWorkspaces = [
      ...this.repositories.workspaces.listForProject(projectId, 100, false),
      ...this.repositories.workspaces.listForProject(projectId, 100, true),
    ];
    const existing = allWorkspaces.find(
      (w) => resolve(w.cwd) === resolve(canonicalPath) || resolve(w.checkoutRoot ?? "") === resolve(canonicalPath)
    );

    if (existing) {
      if (existing.archivedAt) {
        const reopened = workspaceSchema.parse({ ...existing, archivedAt: null });
        this.repositories.workspaces.save(reopened);
        return reopened;
      }
      return workspaceSchema.parse(existing);
    }

    const workspaceId = `wsp_${id()}`;
    const isMain = resolve(canonicalPath) === projectRoot;
    const kind = isMain ? "main-checkout" : "worktree";
    const ownershipState = isMain ? "main-checkout" : "unowned";
    const displayLabel = input.label?.trim() || gitDiscovery.branchRef || canonicalPath.split("/").pop() || "worktree";

    const workspace = workspaceSchema.parse({
      id: workspaceId,
      projectId,
      kind,
      cwd: canonicalPath,
      checkoutRoot: gitDiscovery.checkoutRoot,
      mainRepositoryRoot: gitDiscovery.mainCheckoutRoot,
      branchRef: gitDiscovery.branchRef,
      displayLabel,
      locationId: null,
      ownershipState,
      markerId: null,
      markerPath: null,
      repairDetail: null,
      archivedAt: null,
    });

    this.repositories.workspaces.save(workspace);
    return workspace;
  }

  private async command(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text().catch(() => "")]);
    return { code, stderr: stderr.slice(0, 2000) };
  }

  private async refExists(cwd: string, ref: string): Promise<boolean> {
    const p = Bun.spawn(["git", "-C", cwd, "rev-parse", "--verify", "--quiet", ref], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  }

  private async branchExists(cwd: string, branch: string): Promise<boolean> {
    const p = Bun.spawn(["git", "-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  }

  private mapGitFailure(stderr: string, ref: string, creatingBranch: boolean): WorktreeError {
    const detail = stderr.trim().split("\n").at(-1) ?? "";
    if (/already exists/i.test(detail)) {
      return new WorktreeError("git-failed", `Git refused: ${detail}. Pick a different destination or branch name.`);
    }
    if (/already (used|checked out)/i.test(detail)) {
      return new WorktreeError("git-failed", `Branch "${ref}" is already checked out in another worktree. Use "Existing branch" mode with a different branch, or create a new one.`);
    }
    if (/invalid reference|unknown revision|did not match|not a valid/i.test(detail) || creatingBranch) {
      return new WorktreeError(creatingBranch ? "invalid-ref" : "ref-not-found", `Branch or ref "${ref}" was not found. Check the spelling, pick an existing ref, or use "New branch" mode with a valid base.`);
    }
    return new WorktreeError("git-failed", detail ? `Git worktree failed: ${detail}` : "Git worktree failed. Check the branch, base ref, and destination, then retry.");
  }
}
