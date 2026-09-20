import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataRepositories, MetadataStore } from "../metadata/index.ts";
import { WorkspaceService } from "../workspaces/service.ts";
import { createWorkspaceRoutes } from "./workspaces.ts";
import { createDefaultLayout } from "../../shared/domain/layout.ts";
import { DEFAULT_WORKSPACE_SETTINGS } from "../../shared/domain/settings.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "passage-layout-http-"));
  roots.push(root);
  const store = new MetadataStore(":memory:");
  const workspaceService = new WorkspaceService(new MetadataRepositories(store.db));
  const app = createWorkspaceRoutes(workspaceService);
  return { root, store, workspaceService, app };
}

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe("layout and settings HTTP API", () => {
  test("gets and updates workspace layout", async () => {
    const f = await fixture();
    const project = await (
      await f.app.fetch(
        request("/api/projects", {
          method: "POST",
          body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "Project" }),
        })
      )
    ).json();

    const workspace = await (
      await f.app.fetch(
        request(`/api/projects/${project.id}/workspaces`, {
          method: "POST",
          body: JSON.stringify({ displayLabel: "Workspace" }),
        })
      )
    ).json();

    const defaultLayoutRes = await f.app.fetch(request(`/api/workspaces/${workspace.id}/layout`));
    expect(defaultLayoutRes.status).toBe(200);
    const defaultLayout = await defaultLayoutRes.json();
    expect(defaultLayout.version).toBe(1);
    expect(defaultLayout.root.type).toBe("tabs");

    const customLayout = createDefaultLayout(workspace.id, {
      id: "agent-1",
      kind: "agent",
      title: "Agent 1",
    });

    const putRes = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/layout`, {
        method: "PUT",
        body: JSON.stringify(customLayout),
      })
    );
    expect(putRes.status).toBe(200);
    const savedLayout = await putRes.json();
    expect(savedLayout.root.tabs[0].title).toBe("Agent 1");

    const getUpdatedRes = await f.app.fetch(request(`/api/workspaces/${workspace.id}/layout`));
    const getUpdated = await getUpdatedRes.json();
    expect(getUpdated.root.tabs[0].title).toBe("Agent 1");

    f.store.close();
  });

  test("gets and updates workspace settings", async () => {
    const f = await fixture();
    const project = await (
      await f.app.fetch(
        request("/api/projects", {
          method: "POST",
          body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "Project" }),
        })
      )
    ).json();

    const workspace = await (
      await f.app.fetch(
        request(`/api/projects/${project.id}/workspaces`, {
          method: "POST",
          body: JSON.stringify({ displayLabel: "Workspace" }),
        })
      )
    ).json();

    const getRes = await f.app.fetch(request(`/api/workspaces/${workspace.id}/settings`));
    expect(getRes.status).toBe(200);
    const settings = await getRes.json();
    expect(settings.themeId).toBe(DEFAULT_WORKSPACE_SETTINGS.themeId);

    const customSettings = {
      ...DEFAULT_WORKSPACE_SETTINGS,
      themeId: "passage-light",
      terminalFontSize: 16,
      fonts: {
        ui: "inter",
        mono: "jetbrains-mono",
        editor: "fira-code",
        xterm: "meslo-lg",
      },
      suggestModel: "test/model",
      suggestThinkingLevel: "high",
      timelineExpansion: {
        thinking: "always",
        tools: {
          read: "none",
          write: "always",
          edit: "always",
          bash: "always",
          find: "none",
          grep: "latest",
          ls: "none",
          ask: "none",
        },
        otherTools: "latest",
      },
    };

    const putRes = await f.app.fetch(
      request(`/api/workspaces/${workspace.id}/settings`, {
        method: "PUT",
        body: JSON.stringify(customSettings),
      })
    );
    expect(putRes.status).toBe(200);

    const updatedRes = await f.app.fetch(request(`/api/workspaces/${workspace.id}/settings`));
    const updated = await updatedRes.json();
    expect(updated.themeId).toBe("passage-light");
    expect(updated.terminalFontSize).toBe(16);
    expect(updated.fonts.ui).toBe("inter");
    expect(updated.fonts.mono).toBe("jetbrains-mono");
    expect(updated.fonts.editor).toBe("fira-code");
    expect(updated.fonts.xterm).toBe("meslo-lg");
    expect(updated.timelineExpansion.thinking).toBe("always");
    expect(updated.timelineExpansion.tools.read).toBe("none");
    expect(updated.timelineExpansion.tools.write).toBe("always");
    expect(updated.suggestModel).toBe("test/model");
    expect(updated.suggestThinkingLevel).toBe("high");

    f.store.close();
  });

  test("shares all settings across workspaces (no per-workspace settings)", async () => {
    const f = await fixture();
    const project = await (
      await f.app.fetch(
        request("/api/projects", {
          method: "POST",
          body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "Project" }),
        })
      )
    ).json();

    const createWorkspace = async (displayLabel: string) => {
      const res = await f.app.fetch(
        request(`/api/projects/${project.id}/workspaces`, {
          method: "POST",
          body: JSON.stringify({ displayLabel }),
        }),
      );
      return res.json();
    };
    const workspaceA = await createWorkspace("Workspace A");
    const workspaceB = await createWorkspace("Workspace B");

    const putRes = await f.app.fetch(
      request(`/api/workspaces/${workspaceA.id}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          ...DEFAULT_WORKSPACE_SETTINGS,
          themeId: "nord",
          fonts: { ui: "inter", mono: "jetbrains-mono", editor: "fira-code", xterm: "meslo-lg" },
          terminalFontSize: 16,
          suggestModel: "test/model-a",
          suggestThinkingLevel: "high",
          timelineExpansion: {
            ...DEFAULT_WORKSPACE_SETTINGS.timelineExpansion,
            thinking: "always",
          },
        }),
      })
    );
    expect(putRes.status).toBe(200);

    // Workspace B inherits the global settings.
    const settingsB = await (await f.app.fetch(request(`/api/workspaces/${workspaceB.id}/settings`))).json();
    expect(settingsB.themeId).toBe("nord");
    expect(settingsB.fonts.ui).toBe("inter");
    expect(settingsB.fonts.xterm).toBe("meslo-lg");
    expect(settingsB.suggestModel).toBe("test/model-a");
    expect(settingsB.suggestThinkingLevel).toBe("high");
    expect(settingsB.timelineExpansion.thinking).toBe("always");
    expect(settingsB.terminalFontSize).toBe(16);

    // Saving settings in B is visible in A.
    await f.app.fetch(
      request(`/api/workspaces/${workspaceB.id}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          ...DEFAULT_WORKSPACE_SETTINGS,
          themeId: "passage-dark",
          fonts: { ui: "manrope", mono: "hack", editor: "hack", xterm: "hack" },
          terminalFontSize: 20,
          suggestModel: "test/model-b",
          suggestThinkingLevel: "low",
          timelineExpansion: {
            ...DEFAULT_WORKSPACE_SETTINGS.timelineExpansion,
            thinking: "none",
          },
        }),
      })
    );
    const settingsA = await (await f.app.fetch(request(`/api/workspaces/${workspaceA.id}/settings`))).json();
    expect(settingsA.themeId).toBe("passage-dark");
    expect(settingsA.fonts.ui).toBe("manrope");
    expect(settingsA.suggestModel).toBe("test/model-b");
    expect(settingsA.suggestThinkingLevel).toBe("low");
    expect(settingsA.timelineExpansion.thinking).toBe("none");
    expect(settingsA.terminalFontSize).toBe(20);

    f.store.close();
  });

  test("seeds global appearance from a legacy per-workspace row", async () => {
    const f = await fixture();
    const project = await (
      await f.app.fetch(
        request("/api/projects", {
          method: "POST",
          body: JSON.stringify({ configuredRootPath: f.root, displayLabel: "Project" }),
        })
      )
    ).json();

    const workspace = await (
      await f.app.fetch(
        request(`/api/projects/${project.id}/workspaces`, {
          method: "POST",
          body: JSON.stringify({ displayLabel: "Workspace" }),
        })
      )
    ).json();

    // Simulate a row written before appearance went global: bypass the
    // service so no global row is created.
    const repositories = new MetadataRepositories(f.store.db);
    repositories.workspaces.savePreferences(workspace.id, {
      ...DEFAULT_WORKSPACE_SETTINGS,
      themeId: "nord",
      fonts: { ui: "inter", mono: "jetbrains-mono", editor: "fira-code", xterm: "meslo-lg" },
      suggestModel: "test/legacy-model",
      timelineExpansion: {
        ...DEFAULT_WORKSPACE_SETTINGS.timelineExpansion,
        thinking: "always",
      },
    });

    const seeded = await (await f.app.fetch(request(`/api/workspaces/${workspace.id}/settings`))).json();
    expect(seeded.themeId).toBe("nord");
    expect(seeded.fonts.ui).toBe("inter");
    expect(seeded.suggestModel).toBe("test/legacy-model");
    expect(seeded.timelineExpansion.thinking).toBe("always");

    // The adopted appearance is now global: a fresh workspace inherits it.
    const other = await (
      await f.app.fetch(
        request(`/api/projects/${project.id}/workspaces`, {
          method: "POST",
          body: JSON.stringify({ displayLabel: "Other" }),
        })
      )
    ).json();
    const otherSettings = await (await f.app.fetch(request(`/api/workspaces/${other.id}/settings`))).json();
    expect(otherSettings.themeId).toBe("nord");
    expect(otherSettings.fonts.xterm).toBe("meslo-lg");
    expect(otherSettings.suggestModel).toBe("test/legacy-model");
    expect(otherSettings.timelineExpansion.thinking).toBe("always");

    f.store.close();
  });

  test("serves customization packs", async () => {
    const f = await fixture();
    const themesRes = await f.app.fetch(request("/api/customization/themes"));
    expect(themesRes.status).toBe(200);
    const themes = await themesRes.json();
    expect(Array.isArray(themes)).toBe(true);
    expect(themes.length).toBeGreaterThanOrEqual(3);

    const fontOptionsRes = await f.app.fetch(request("/api/customization/font-options"));
    expect(fontOptionsRes.status).toBe(200);
    const fontOptions = await fontOptionsRes.json();
    expect(Array.isArray(fontOptions)).toBe(true);
    expect(fontOptions.length).toBeGreaterThanOrEqual(10);
    for (const option of fontOptions) {
      expect(typeof option.id).toBe("string");
      expect(typeof option.family).toBe("string");
    }
    expect(fontOptions.some((option: { id: string }) => option.id === "jetbrains-mono")).toBe(true);
    expect(fontOptions.some((option: { id: string }) => option.id === "inter")).toBe(true);

    const toolsRes = await f.app.fetch(request("/api/customization/tool-renderers"));
    expect(toolsRes.status).toBe(200);
    const tools = await toolsRes.json();
    expect(tools.id).toBe("builtin");

    f.store.close();
  });
});
