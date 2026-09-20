import { resolve } from "node:path";
import type { ProjectBranch } from "../../shared/domain/git.ts";
import type { MetadataRepositories } from "../metadata/repositories.ts";
import { GitService } from "./git.ts";

export class BranchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/** Project branch review: every live local git branch annotated with the
 *  Passage workspace rows that track it. SQLite holds the tracking state
 *  (workspace `branchRef` values); git holds the branch truth. Neither is
 *  copied into the other -- this service joins them per request. */
export class BranchService {
  constructor(
    private readonly repositories: MetadataRepositories,
    private readonly git = new GitService(),
  ) {}

  async list(projectId: string): Promise<ProjectBranch[]> {
    const project = this.repositories.projects.get(projectId);
    if (!project || project.archivedAt) {
      throw new BranchError("invalid-project", "Active project required");
    }
    const workspaces = [
      ...this.repositories.workspaces.listForProject(projectId, 100, false),
      ...this.repositories.workspaces.listForProject(projectId, 100, true),
    ];
    const byBranch = new Map<string, typeof workspaces>();
    for (const w of workspaces) {
      if (!w.branchRef) continue;
      const list = byBranch.get(w.branchRef) ?? [];
      list.push(w);
      byBranch.set(w.branchRef, list);
    }

    const cwd = project.canonicalRootPath;
    const [branches, worktreeEntries, current] = await Promise.all([
      this.git.listBranches(cwd).catch(() => []),
      this.git.listWorktrees(cwd).catch(() => []),
      this.git
        .status(cwd)
        .then((s) => s.branchRef)
        .catch(() => null),
    ]);
    const worktreeByBranch = new Map<string, string>();
    for (const entry of worktreeEntries) {
      if (entry.branchRef && !worktreeByBranch.has(entry.branchRef)) {
        worktreeByBranch.set(entry.branchRef, entry.path);
      }
    }
    // Merged-into-main badge: prefer a local trunk ref when one exists.
    let merged = new Set<string>();
    for (const base of ["main", "master"]) {
      try {
        merged = await this.git.mergedBranches(cwd, base);
        if (merged.size > 0 || (await this.hasLocalBranch(cwd, base))) break;
      } catch {
        // Fall through to the next candidate base.
      }
    }

    const projectRoot = resolve(cwd);
    return branches
      .map((b): ProjectBranch => {
        const tracked = (byBranch.get(b.name) ?? []).map((w) => ({
          workspaceId: w.id,
          displayLabel: w.displayLabel,
          kind: w.kind,
          archivedAt: w.archivedAt,
        }));
        const worktreePath = worktreeByBranch.get(b.name) ?? null;
        const isMainCheckout = worktreePath !== null && resolve(worktreePath) === projectRoot;
        return {
          name: b.name,
          head: b.head,
          upstream: b.upstream,
          lastCommitAt: b.lastCommitAt,
          subject: b.subject,
          isCurrent: current === b.name,
          isMain: b.name === "main" || b.name === "master" || isMainCheckout,
          isCheckedOut: worktreePath !== null,
          worktreePath,
          mergedIntoMain: b.name === "main" || b.name === "master" ? null : merged.has(b.name),
          trackedWorkspaces: tracked.slice(0, 100),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(projectId: string, branch: string, force = false): Promise<ProjectBranch[]> {
    const project = this.repositories.projects.get(projectId);
    if (!project || project.archivedAt) {
      throw new BranchError("invalid-project", "Active project required");
    }
    const name = branch.trim();
    if (!name) throw new BranchError("invalid-branch", "Branch name is required");
    try {
      await this.git.deleteBranch(project.canonicalRootPath, name, force);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git branch delete failed";
      // Surface unmerged-work as a force-required signal so the UI can offer
      // the explicit second force confirm instead of a dead-end error.
      const code = /not fully merged/i.test(message) ? "force-required" : "git-failed";
      throw new BranchError(code, message);
    }
    return this.list(projectId);
  }

  private async hasLocalBranch(cwd: string, branch: string): Promise<boolean> {
    try {
      const p = Bun.spawn(["git", "-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return (await p.exited) === 0;
    } catch {
      return false;
    }
  }
}
