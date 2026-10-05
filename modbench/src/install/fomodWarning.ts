import type { Reporter } from '../ports/reporter';

export const warnIfFomod = (reporter: Pick<Reporter, 'report'>) => (name: string, isFomod: boolean): void => {
  if (isFomod)
    reporter.report(
      'warning',
      `"${name}" is a FOMOD installer — its files were copied as-is and need manual ` +
        `arrangement; Modbench does not run the installer's own install steps.`,
    );
};
