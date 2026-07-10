// Delete-to-trash sequencing for the Downloads tab, extracted from the VS Code
// adapter so the destructive ordering is unit-testable. No VS Code types in the
// interface — the panel injects the confirm / trash / report surface, per the
// repo's testability rule (mirrors SessionController's injected reporter).

export interface DeleteDownloadDeps {
  /** Absolute path of the archive to trash. */
  archivePath: string;
  /** Absolute path of the archive's `.meta` sidecar (trashed only if present). */
  metaPath: string;
  /** Show the modal confirmation; resolves true only if the user confirmed. */
  confirm: () => Promise<boolean>;
  /** Whether the `.meta` sidecar exists on disk. */
  metaExists: () => Promise<boolean>;
  /** Move a path to the system trash. */
  trash: (path: string) => Promise<void>;
  /** Surface a failure per ADR-0026 (log + error notification). */
  reportFailure: (message: string) => void;
}

/** Delete an archive — and its `.meta` sidecar, if any — to the system trash,
 *  behind a confirmation. The `.meta` is trashed BEFORE the archive so a
 *  mid-failure never orphans a sidecar: worst case leaves the archive as a
 *  normal metaless Downloaded row, never a lone `.meta`. Cancel is a silent
 *  no-op (never the error path); a trash failure is surfaced via `reportFailure`
 *  (ADR-0026: explicit user action failed → error notification + log). */
export async function deleteDownload(deps: DeleteDownloadDeps): Promise<void> {
  if (!(await deps.confirm())) return;
  try {
    if (await deps.metaExists()) await deps.trash(deps.metaPath);
    await deps.trash(deps.archivePath);
  } catch (err) {
    deps.reportFailure(err instanceof Error ? err.message : String(err));
  }
}
