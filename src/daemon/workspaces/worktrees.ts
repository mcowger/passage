import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { workspaceSchema, type Workspace } from "../../shared/domain/workspaces.ts";
import { GitService } from "./git.ts";
import type { MetadataRepositories } from "../metadata/repositories.ts";
import { MetadataGenerator, type WorktreeSuggestion } from "./metadata-generator.ts";

export class WorktreeError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
export type WorktreeMarker = { formatVersion: 1; workspaceId: string; markerId: string; expectedCheckout: string; ref: string };
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
  async create(projectId: string, locationId: string, ref: string, label: string, folder?: string): Promise<Workspace> {
    const project = this.repositories.projects.get(projectId); if (!project || project.archivedAt) throw new WorktreeError("invalid-project", "Active project required");
    const location = this.repositories.worktreeLocations.get(locationId); if (!location || !location.enabled || (location.projectId && location.projectId !== projectId)) throw new WorktreeError("invalid-location", "Enabled location required");
    if (!ref || ref.startsWith("-") || ref.includes("..")) throw new WorktreeError("invalid-ref", "Invalid Git ref");
    const parent = await realpath(location.canonicalRootPath); let name = (folder ?? label).trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "worktree";
    let destination = join(parent, name); for (let n = 2; true; n++) { try { await realpath(destination); destination = join(parent, `${name}-${n}`); } catch { break; } }
    if (!inside(parent, destination)) throw new WorktreeError("outside-location", "Destination is outside location");
    const result = await this.command(project.canonicalRootPath, ["worktree", "add", destination, ref]); if (result !== 0) throw new WorktreeError("git-failed", "Unable to create worktree");
    const workspaceId = `wsp_${id()}`, markerId = id(), markerPath = join(destination, markerName);
    const marker: WorktreeMarker = { formatVersion: 1, workspaceId, markerId, expectedCheckout: destination, ref };
    try { await writeFile(markerPath, JSON.stringify(marker), { flag: "wx" }); const discovered = await this.git.discover(destination); const workspace = workspaceSchema.parse({ id: workspaceId, projectId, kind: "worktree", cwd: destination, checkoutRoot: discovered.checkoutRoot, mainRepositoryRoot: discovered.mainCheckoutRoot, branchRef: discovered.branchRef, displayLabel: label, locationId, ownershipState: "owned", markerId, markerPath, repairDetail: null, archivedAt: null }); this.repositories.workspaces.save(workspace); return workspace; } catch (error) { const repair = workspaceSchema.parse({ id: workspaceId, projectId, kind: "worktree", cwd: destination, checkoutRoot: destination, mainRepositoryRoot: project.canonicalRootPath, branchRef: ref, displayLabel: label, locationId, ownershipState: "repair", markerId, markerPath, repairDetail: String(error), archivedAt: null }); try { this.repositories.workspaces.save(repair); } catch {} throw error; }
  }
  async reconcile(workspaceId: string): Promise<Workspace> { const w = this.repositories.workspaces.get(workspaceId); if (!w) throw new WorktreeError("not-found", "Workspace not found"); if (w.kind !== "worktree" || !w.markerPath) return workspaceSchema.parse(w); const marker = JSON.parse(await readFile(w.markerPath, "utf8")) as WorktreeMarker; if (marker.workspaceId !== w.id || marker.markerId !== w.markerId || marker.expectedCheckout !== w.cwd) throw new WorktreeError("marker-mismatch", "Ownership marker mismatch"); const fixed = workspaceSchema.parse({ ...w, ownershipState: "owned", repairDetail: null }); this.repositories.workspaces.save(fixed); return fixed; }
  async remove(workspaceId: string, force = false): Promise<void> {
    const w = this.repositories.workspaces.get(workspaceId);
    if (!w || w.kind !== "worktree") throw new WorktreeError("not-found", "Workspace not found");
    if (w.ownershipState === "owned") {
      if (!w.markerPath || !w.markerId) throw new WorktreeError("not-owned", "Passage ownership record required");
      const marker = JSON.parse(await readFile(w.markerPath, "utf8")) as WorktreeMarker;
      if (marker.workspaceId !== w.id || marker.markerId !== w.markerId || marker.expectedCheckout !== w.cwd) {
        throw new WorktreeError("marker-mismatch", "Ownership marker mismatch");
      }
    }
    const status = await this.git.status(w.cwd);
    if ((status.dirty || status.conflicted) && !force) throw new WorktreeError("force-required", "Explicit force confirmation required");
    if (resolve(w.cwd) === resolve(w.mainRepositoryRoot ?? "")) throw new WorktreeError("main-checkout", "Main checkout cannot be removed");
    const code = await this.command(w.mainRepositoryRoot ?? w.cwd, ["worktree", "remove", ...(force ? ["--force"] : []), w.cwd]);
    if (code !== 0) throw new WorktreeError("git-failed", "Unable to remove worktree");
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

    const markerPath = join(canonicalPath, markerName);
    let markerId: string | null = null;
    let hasMarker = false;
    try {
      const raw = await readFile(markerPath, "utf8");
      const parsed = JSON.parse(raw) as WorktreeMarker;
      if (parsed.markerId) {
        markerId = parsed.markerId;
        hasMarker = true;
      }
    } catch {}

    const workspaceId = `wsp_${id()}`;
    const isMain = resolve(canonicalPath) === projectRoot;
    const kind = isMain ? "main-checkout" : "worktree";
    const ownershipState = hasMarker ? "owned" : isMain ? "main-checkout" : "unowned";
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
      markerId: hasMarker ? markerId : null,
      markerPath: hasMarker ? markerPath : null,
      repairDetail: null,
      archivedAt: null,
    });

    this.repositories.workspaces.save(workspace);
    return workspace;
  }

  private async command(cwd: string, args: string[]): Promise<number> { const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" }); return await p.exited; }
}
