import type { Reporter } from '../ports/reporter';
import { errorMessage } from '../ports/errorMessage';
import type { Subscription } from '../instanceAdapter/instanceAdapter';

/** VS Code's `ConfigurationChangeEvent`, as much of it as the launch reads. */
interface ConfigChangeEvent {
  affectsConfiguration(section: string): boolean;
}

interface LaunchDeps {
  setting: string;
  client: { status: string };
  /** Absent outside an instance, where there is no backend to launch. */
  enterEditing: (() => Promise<void>) | undefined;
  exitEditing: () => void;
  reporter: Pick<Reporter, 'report'>;
  onConfigChange: (listener: (e: ConfigChangeEvent) => void) => Subscription;
}

/** The backend launches with the extension (ADR-0002), and a change to the game folder setting is
 *  its only retry. */
export function launchBackend(deps: LaunchDeps): Subscription {
  const { setting, client, enterEditing, exitEditing, reporter, onConfigChange } = deps;
  const launch = async () => {
    try {
      await enterEditing?.();
    } catch (err) {
      exitEditing();
      reporter.report('error', 'Failed to launch mEdit.', errorMessage(err));
    }
  };
  void launch();
  return onConfigChange((e) => {
    if (e.affectsConfiguration(setting) && client.status !== 'running') void launch();
  });
}
