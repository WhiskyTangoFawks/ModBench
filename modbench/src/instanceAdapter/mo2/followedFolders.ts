import { outsideTrustedRead } from '../files';
import type { Subscription } from '../instanceAdapter';

interface Followed {
  readonly glob: string;
  readonly watches: ReadonlyMap<string, Subscription | undefined>;
}

interface FollowedDeps {
  readonly watch: (base: string, glob: string) => Subscription;
  readonly armed: () => boolean;
  readonly checkDue: () => void;
  readonly forget: (base: string, glob: string) => void;
}

/** The folders a read follows, each kind watched under its own glob while the watch is armed. */
export function followedFolders({ watch, armed, checkDue, forget }: FollowedDeps) {
  const followed = new Map<string, Followed>();
  const rearmed = ({ glob, watches }: Followed, arming: (base: string) => Subscription | undefined): Followed => {
    for (const watching of watches.values()) watching?.dispose();
    return { glob, watches: new Map([...watches.keys()].map((base) => [base, arming(base)])) };
  };

  return {
    /** Watches each of `bases` under `glob` for `what`, in place of the folders it followed before; a newly armed watch has the disk checked once. */
    follow: (what: string, bases: readonly string[], glob: string): void => outsideTrustedRead(() => {
      const before: Followed = followed.get(what) ?? { glob, watches: new Map<string, Subscription | undefined>() };
      const kept = new Set(before.glob === glob ? bases : []);
      const watches = new Map<string, Subscription | undefined>();
      for (const [base, watching] of before.watches) {
        if (kept.has(base)) watches.set(base, watching);
        else {
          watching?.dispose();
          forget(base, before.glob);
        }
      }
      const added = bases.filter((base) => !watches.has(base));
      for (const base of added) watches.set(base, armed() ? watch(base, glob) : undefined);
      followed.set(what, { glob, watches });
      if (added.length > 0 && armed()) checkDue();
    }),
    arm(): void {
      for (const [what, folders] of followed) followed.set(what, rearmed(folders, (base) => watch(base, folders.glob)));
    },
    disarm(): void {
      for (const [what, folders] of followed) followed.set(what, rearmed(folders, () => undefined));
    },
    entries: (): { base: string; glob: string }[] => [...followed.values()].flatMap(({ glob, watches }) => [...watches.keys()].map((base) => ({ base, glob }))),
  };
}
