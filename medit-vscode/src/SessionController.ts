import type { ApiClient, PluginMetadata } from './ApiClient';
import type { SessionWizard } from './SessionWizard';

export interface SessionControllerDeps {
  client: ApiClient;
  makeWizard: () => SessionWizard;
  refreshTree: () => void;
  setStatusText: (text: string) => void;
  showWarning: (msg: string) => void;
  showError: (msg: string) => void;
}

export class SessionController {
  constructor(private readonly deps: SessionControllerDeps) {}

  async getPlugins(): Promise<PluginMetadata[]> {
    const { data } = await this.deps.client.GET('/plugins', {});
    return (data as PluginMetadata[] | undefined) ?? [];
  }

  async createPlugin(name: string): Promise<void> {
    const { response } = await this.deps.client.POST('/plugins/create', { body: { name } });
    if (!response.ok) {
      const text = await response.text();
      this.deps.showError(`mEdit: Failed to create plugin — ${text}`);
      return;
    }
    this.deps.refreshTree();
  }

  async copyRecordTo(formKey: string, target: string): Promise<void> {
    const { response } = await this.deps.client.POST(
      '/records/{formKey}/copy-to/{targetPlugin}',
      { params: { path: { formKey, targetPlugin: target } } },
    );
    if (!response.ok) {
      const text = await response.text();
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

  async onBackendConnected(): Promise<void> {
    const loaded = await this.deps.makeWizard().run();
    if (!loaded) {
      this.deps.setStatusText('$(plug) mEdit: No session');
      this.deps.refreshTree();
      return;
    }
    const plugins = await this.getPlugins();
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
