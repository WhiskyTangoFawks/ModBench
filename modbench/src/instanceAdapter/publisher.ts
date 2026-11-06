// The Instance adapter as a mod manager's implementation and a publisher's make it together
// (ADR-0024): the mod manager answers everything but the publisher's configuration.

import type { ChangeListener, InstanceAdapter, InstanceReading, PublisherConfiguration, PublisherTag, Reread, Subscription } from './instanceAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { PathSpelling, TokenProgram } from './pathTokens';
import type { EntryReading, HeldTexts } from '../symbolNames/symbolNames';

export type ManagerReading = Omit<InstanceReading, 'publisherConfiguration'>;

export type ManagerAdapter = Omit<InstanceAdapter, 'reading' | 'publisherTags' | 'changePublisherTag' | 'followModFolders' | 'publisherConfigurationRefusal' | 'scriptEnvironmentFile'> & {
  reading(reread?: Reread): Promise<ManagerReading>;
  filesKept(): Promise<KeptFiles>;
};

/** A configuration file, from the instance root, and how it spells a path. */
export interface ConfigurationFile {
  readonly name: string;
  readonly spelling: PathSpelling;
  /** What the file holds of this machine alone, blanked when git holds the file, and put back from the text this machine holds. */
  readonly blanked?: (thisMachine: string) => TokenProgram;
}

interface KeptFiles {
  readonly present: readonly string[];
  /** Whether a path is one of the shapes Modbench keeps a file at, there now or not. */
  readonly owns: (path: string) => boolean;
}

interface NamedSpan {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export interface Publisher {
  readonly tags: readonly PublisherTag[];
  readonly configurationFile: ConfigurationFile;
  configuration(): Promise<PublisherConfiguration>;
  /** Why the configuration cannot be read, without checking the paths it names. */
  refusal(): Promise<string | undefined>;
  /** Each place the configuration's entries name the folder, at its segment of every entry at or under it, and why the
   *  configuration could not be read. */
  namesFolder(folder: string, held: HeldTexts): Promise<EntryReading>;
  /** The segment of an entry at `offset` of the configuration's `text`, when `folderOf` says the folder it names is at
   *  that path; undefined where `file` is no configuration or no such segment is there. */
  folderAt(file: string, text: string, offset: number, folderOf: (name: string) => Promise<string | undefined>): Promise<NamedSpan | undefined>;
  changeTag: InstanceAdapter['changePublisherTag'];
  followFolders: InstanceAdapter['followModFolders'];
  /** Lists each kept file in the ignore list, leaving every other entry as written. Rejects, writing nothing, for a
   *  configuration it cannot read; does nothing when the instance holds none. */
  keepOut(kept: KeptFiles): Promise<void>;
  /** Hears each change to the publisher's configuration. */
  subscribe(listener: ChangeListener): Subscription;
}

const withEnvironmentFile = ({ present, owns }: KeptFiles, environmentFile: string): KeptFiles => ({ present: [...present, environmentFile], owns });

export function withPublisher(manager: ManagerAdapter, publisher: Publisher, scriptEnvironmentFilePath: () => string): Omit<InstanceAdapter, 'scriptEnvironmentFile'> {
  const keepOut = async () => publisher.keepOut(withEnvironmentFile(await manager.filesKept(), scriptEnvironmentFilePath()));
  const afterKeepingOut = async <T>(write: Promise<T>): Promise<T> => {
    const written = await write;
    await keepOut();
    return written;
  };
  return {
    ...manager,
    entryReferences: {
      listed: (held) => manager.entryReferences.listed(held),
      read: async (entry, held) => {
        const [files, folder] = await Promise.all([manager.entryReferences.read(entry, held), entry.kind === 'mod' ? manager.modFolderPath(entry.name) : undefined]);
        const tags = folder === undefined ? { references: [], leftOut: [] } : await publisher.namesFolder(folder, held);
        return { references: [...files.references, ...tags.references], leftOut: [...files.leftOut, ...tags.leftOut] };
      },
      nameAt: async (file, text, offset) => {
        const named = await manager.entryReferences.nameAt(file, text, offset);
        if (named !== undefined) return named;
        const folder = await publisher.folderAt(file, text, offset, (name) => manager.modFolderPath(name));
        return folder && { entry: { kind: 'mod', name: folder.name }, start: folder.start, end: folder.end };
      },
    },
    publisherTags: publisher.tags,
    changePublisherTag: (...change) => afterKeepingOut(publisher.changeTag(...change)),
    followModFolders: (moves) => afterKeepingOut(publisher.followFolders(moves)),
    publisherConfigurationRefusal: () => publisher.refusal(),
    reading: async (reread) => {
      const [reading, publisherConfiguration] = await Promise.all([manager.reading(reread), keptOutConfiguration()]);
      return { ...reading, publisherConfiguration };
    },
    subscribe: (listener) => {
      const heard = [manager.subscribe(listener), publisher.subscribe(listener)];
      return { dispose: () => { for (const subscription of heard) subscription.dispose(); } };
    },
  };

  async function keptOutConfiguration(): Promise<PublisherConfiguration> {
    try {
      await keepOut();
    } catch (err) {
      return { kind: 'unreadable', reason: errorMessage(err) };
    }
    return publisher.configuration();
  }
}
