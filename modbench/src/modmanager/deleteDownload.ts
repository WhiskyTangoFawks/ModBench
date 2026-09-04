// No VS Code types in the interface: the panel injects the confirm/trash/report surface, so
// the destructive ordering stays unit-testable.

export interface DeleteDownloadDeps {
  /** Absolute path of the archive to trash. */
  archivePath: string;
  /** Absolute path of the archive's `.meta` sidecar (trashed only if present). */
  metaPath: string;
  /** Show the modal confirmation; resolves true only if the user confirmed. */
  confirm: () => Promise<boolean>;
  metaExists: () => Promise<boolean>;
  trash: (path: string) => Promise<void>;
  /** Surface a failure per ADR-0026 (log + error notification). */
  reportFailure: (message: string) => void;
}

/** The `.meta` is trashed BEFORE the archive, so a mid-failure leaves a metaless archive —
 *  an ordinary Downloaded row — never a lone `.meta`. Cancel is a silent no-op. */
export async function deleteDownload(deps: DeleteDownloadDeps): Promise<void> {
  if (!(await deps.confirm())) return;
  try {
    if (await deps.metaExists()) await deps.trash(deps.metaPath);
    await deps.trash(deps.archivePath);
  } catch (err) {
    deps.reportFailure(err instanceof Error ? err.message : String(err));
  }
}
