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
  const store = new MetadataStore(join(root, "metadata.sqlite"));
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
    expect(updated.timelineExpansion.thinking).toBe("always");
    expect(updated.timelineExpansion.tools.read).toBe("none");
    expect(updated.timelineExpansion.tools.write).toBe("always");

    f.store.close();
  });

  test("serves customization packs", async () => {
    const f = await fixture();
    const themesRes = await f.app.fetch(request("/api/customization/themes"));
    expect(themesRes.status).toBe(200);
    const themes = await themesRes.json();
    expect(Array.isArray(themes)).toBe(true);
    expect(themes.length).toBeGreaterThanOrEqual(3);

    const fontsRes = await f.app.fetch(request("/api/customization/fonts"));
    expect(fontsRes.status).toBe(200);
    const fonts = await fontsRes.json();
    expect(Array.isArray(fonts)).toBe(true);

    const toolsRes = await f.app.fetch(request("/api/customization/tool-renderers"));
    expect(toolsRes.status).toBe(200);
    const tools = await toolsRes.json();
    expect(tools.id).toBe("builtin");

    f.store.close();
  });
});
