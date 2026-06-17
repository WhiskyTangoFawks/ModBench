import type { ApiClient } from './ApiClient';
import type { PluginRepository } from './PluginRepository';
import type { SessionWizard } from './SessionWizard';

export interface SessionControllerDeps {
  client: ApiClient;
  repository: PluginRepository;
  makeWizard: () => SessionWizard;
  refreshTree: () => void;
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

  async loadSession(): Promise<void> {
    const loaded = await this.deps.makeWizard().run();
    if (!loaded) return;
    this.deps.setStatusText('$(check) mEdit: Ready');
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

  async onBackendConnected(): Promise<void> {
    const loaded = await this.deps.makeWizard().run();
    if (!loaded) {
      this.deps.setStatusText('$(plug) mEdit: No session');
      this.deps.refreshTree();
      return;
    }
    const plugins = await this.deps.repository.getPlugins();
    const count = plugins.length;
    if (count === 0) {
      this.deps.showWarning(
        'mEdit: Session loaded but no plugins were found. ' +
        'Plugins.txt may be listing no plugins (common with vanilla post-NextGen FO4). ' +
        'Use MO2 or add plugins to Plugins.txt manually.',
      );
    }
    this.deps.setStatusText(`$(check) mEdit: Ready (${count} plugins)`);
    this.deps.refreshTree();
  }
}
