import type { FomodLanded } from '../modCommands/modCommands';
import type { Reporter } from '../ports/reporter';

export const warnIfFomod = (reporter: Pick<Reporter, 'report'>) => (name: string, fomod: FomodLanded | undefined): void => {
  if (fomod?.kind === 'plainCopy')
    reporter.report(
      'warning',
      `"${name}" is a FOMOD installed as a plain copy: its files need arranging by hand, because its installer's own steps did not run: ${fomod.why}.`,
    );
};
