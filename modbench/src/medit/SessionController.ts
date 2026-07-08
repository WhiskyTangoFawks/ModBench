import type { ApiClient } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import { reportSkippedPlugins } from './sessionFailures';

export interface SessionControllerDeps {
  client: ApiClient;
  repository: PluginRepository;
  refreshTree: () => void;
  refreshGroupTree: () => void;
  setStatusText: (text: string) => void;
  showWarning: (msg: string) => void;
  showError: (msg: string) => void;
  setFilterActive: (active: boolean, sql?: string) => void;
  log?: (msg: string) => void;
}

export class SessionController {
  private readonly log: (msg: string) => void;
  constructor(private readonly deps: SessionControllerDeps) {
    this.log = deps.log ?? (() => {});
  }

  async createPlugin(name: string): Promise<void> {
    const { response } = await this.deps.client.POST('/plugins/create', { body: { name } });
    if (!response.ok) {
      const text = await response.text();
      this.log(`[SessionController] createPlugin failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Failed to create plugin — ${text}`);
      return;
    }
    this.deps.refreshTree();
  }

  async copyRecordTo(formKey: string, target: string): Promise<void> {
    const { response } = await this.deps.client.POST(
      '/records/{formKey}/copy-to/{targetPlugin}',
      { params: { path: { formKey, targetPlugin: target } }, body: {} },
    );
    if (!response.ok) {
      const text = await response.text();
      this.log(`[SessionController] copyRecordTo failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Copy failed — ${text}`);
      return;
    }
    this.deps.refreshTree();
  }

  /** Load the editing session from an ordered { name, path } list built from the
   *  active modlist (POST /session/load-explicit). `gameDirectory` must be the
   *  resolved Data folder — the backend prepends implicit masters from it. */
  async loadExplicitSession(
    plugins: { name: string; path: string }[],
    gameDirectory: string,
    gameRelease = 'Fallout4',
  ): Promise<void> {
    const { data, response } = await this.deps.client.POST('/session/load-explicit', {
      body: { plugins, gameDirectory, gameRelease },
    });
    if (!response.ok) {
      const text = await response.text();
      this.log(`[SessionController] loadExplicitSession failed (${response.status}): ${text}`);
      this.deps.showError(`mEdit: Failed to load session — ${text}`);
      return;
    }
    reportSkippedPlugins(data?.failures, {
      log: (m) => this.log(`[SessionController] ${m}`),
      warn: this.deps.showWarning,
    });
    if (plugins.length === 0) {
      // Only base-game masters loaded — the user's mental model ("my mods are
      // loaded") would be silently wrong (ADR-0026 integrity tier).
      this.deps.showWarning(
        'mEdit: The active profile has no enabled plugins — only base-game masters were loaded. ' +
          'Enable plugins in the mod list (or check the profile\'s plugins.txt).',
      );
    }
    this.deps.setStatusText(`$(check) mEdit: Ready (${plugins.length} plugins)`);
    this.deps.refreshTree();
  }

  async setFilter(sql: string): Promise<boolean> {
    const error = await this.deps.repository.setFilter(sql);
    if (error) {
      this.deps.showError(`mEdit: Filter failed — ${error}`);
      return false;
    }
    this.deps.setFilterActive(true, sql);
    this.deps.refreshTree();
    return true;
  }

  async clearFilter(): Promise<void> {
    await this.deps.repository.clearFilter();
    this.deps.setFilterActive(false);
    this.deps.refreshTree();
  }

  async syncFilterState(): Promise<void> {
    const sql = await this.deps.repository.getActiveFilter();
    this.deps.setFilterActive(sql !== null, sql ?? undefined);
  }

  async deleteRecords(records: { formKey: string; plugin: string }[]): Promise<boolean> {
    try {
      const { response } = await this.deps.client.POST('/records/delete', { body: { records } });
      if (!response.ok) {
        const text = await response.text();
        this.log(`[SessionController] deleteRecords failed (${response.status}): ${text}`);
        this.deps.showError(`mEdit: Delete failed — ${text}`);
        return false;
      }
      this.deps.refreshTree();
      return true;
    } catch (e) {
      this.log(`[SessionController] deleteRecords threw: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.showError(`mEdit: Delete failed — ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async createPlaced(
    plugin: string,
    cellFormKey: string,
    recordType: string,
    placementGroup: string,
    templateFormKey?: string,
  ): Promise<void> {
    try {
      const { response } = await this.deps.client.POST(
        '/plugins/{plugin}/cells/{cellFormKey}/placed',
        { params: { path: { plugin, cellFormKey } }, body: { recordType, placementGroup, templateFormKey } },
      );
      if (!response.ok) {
        const text = await response.text();
        this.log(`[SessionController] createPlaced failed (${response.status}): ${text}`);
        this.deps.showError(`mEdit: Create placed failed — ${text}`);
        return;
      }
      this.deps.refreshTree();
    } catch (e) {
      this.log(`[SessionController] createPlaced threw: ${e instanceof Error ? e.message : String(e)}`);
      this.deps.showError(`mEdit: Create placed failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async saveGroup(groupId: string): Promise<void> {
    const { response } = await this.deps.client.POST('/change-groups/{groupId}/save', {
      params: { path: { groupId } },
    });
    if (response.ok || response.status === 404) {
      this.deps.refreshGroupTree();
      this.deps.refreshTree();
      return;
    }
    const text = await response.text();
    this.log(`[SessionController] saveGroup failed (${response.status}): ${text}`);
    this.deps.showError(`mEdit: Save failed — ${text}`);
  }

  async revertGroup(groupId: string): Promise<void> {
    const { response } = await this.deps.client.DELETE('/changes/group/{groupId}', {
      params: { path: { groupId } },
    });
    if (response.ok) {
      this.deps.refreshGroupTree();
      return;
    }
    const text = await response.text();
    this.log(`[SessionController] revertGroup failed (${response.status}): ${text}`);
    this.deps.showError(`mEdit: Revert failed — ${text}`);
  }

  async saveAllGroups(): Promise<void> {
    const { data, response } = await this.deps.client.GET('/change-groups', {});
    if (!response.ok || !Array.isArray(data)) {
      this.deps.showError('mEdit: Failed to fetch change groups');
      return;
    }
    const groups = data.filter(g => g.id);
    if (groups.length === 0) return;
    const failed: string[] = [];
    let anySucceeded = false;
    for (const g of groups) {
      const { response: r } = await this.deps.client.POST('/change-groups/{groupId}/save', {
        params: { path: { groupId: g.id! } },
      });
      if (r.ok || r.status === 404) {
        anySucceeded = true;
      } else {
        failed.push(g.id!);
        this.log(`[SessionController] saveAllGroups: group ${g.id} failed (${r.status})`);
      }
    }
    if (anySucceeded) {
      this.deps.refreshGroupTree();
      this.deps.refreshTree();
    }
    if (failed.length > 0) {
      this.deps.showError(`mEdit: Failed to save groups: ${failed.join(', ')}`);
    }
  }

  async revertAllGroups(): Promise<void> {
    const { data, response } = await this.deps.client.GET('/change-groups', {});
    if (!response.ok || !Array.isArray(data)) {
      this.deps.showError('mEdit: Failed to fetch change groups');
      return;
    }
    for (const g of data.filter(g => g.id)) {
      await this.revertGroup(g.id!);
    }
  }
}
