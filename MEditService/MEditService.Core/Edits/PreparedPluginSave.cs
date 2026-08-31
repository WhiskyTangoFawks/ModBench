namespace MEditService.Core.Edits;

/// <summary>An uncommitted plugin write: a temp-written binary (and, for a Localized mod, its temp-written
/// strings files) plus the timestamped <c>.bak</c> already made — <see cref="Commit"/> to make it real,
/// <see cref="Dispose"/> to discard the temp state either way.</summary>
/// <param name="stringsFiles">A Localized mod's <c>.STRINGS</c>/<c>.DLSTRINGS</c>/<c>.ILSTRINGS</c>
/// files, each already written whole to a temp path by <see cref="PluginWriter.PrepareFromModAsync"/>
/// — empty for a non-Localized mod. <see cref="Commit"/> moves each into its real destination
/// alongside the plugin binary; nothing here is ADR-0008's timestamped <c>.bak</c> concern (that
/// stays scoped to the plugin itself), only the same temp-write-then-rename discipline.</param>
public sealed class PreparedPluginSave(
    string tmpPath,
    string finalPath,
    string backupPath,
    IReadOnlyList<(string TempPath, string FinalPath)>? stringsFiles = null) : IDisposable
{
    private readonly IReadOnlyList<(string TempPath, string FinalPath)> _stringsFiles = stringsFiles ?? [];
    private string? _rollbackPath;

    /// <summary>The timestamped user-facing <c>.bak</c> this attempt created (ADR-0008).</summary>
    public string BackupPath => backupPath;

    public void Commit()
    {
        _rollbackPath = finalPath + ".medit-rollback";
        // overwrite:true so a stale backup left behind by a prior crash doesn't permanently
        // block saves of this plugin
        File.Move(finalPath, _rollbackPath, overwrite: true);
        // finalPath is guaranteed gone at this point (the line above just moved it away, or
        // threw), so no overwrite is needed here
        File.Move(tmpPath, finalPath);

        // Every strings write already succeeded (it happened during Prepare, into temp) by
        // the time Commit runs, so this is pure rename — the same "only move once everything has
        // succeeded" guarantee the plugin binary itself gets above. overwrite:true because a second
        // save of the same Localized plugin is the common case, not the first.
        foreach (var (tempStringsPath, finalStringsPath) in _stringsFiles)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(finalStringsPath)!);
            File.Move(tempStringsPath, finalStringsPath, overwrite: true);
        }
    }

    public void Dispose()
    {
        try
        {
            if (_rollbackPath != null) File.Delete(_rollbackPath); // committed but never rolled back; best-effort
            File.Delete(tmpPath); // no-op if already moved
            var tmpDir = Path.GetDirectoryName(tmpPath)!;
            // Recursive — tmpDir can also hold a nested Strings/ temp subfolder (moved out
            // file by file on Commit, but left behind whole on an uncommitted Dispose, or partially
            // drained on a Commit that threw partway through the strings loop above).
            if (Directory.Exists(tmpDir))
                Directory.Delete(tmpDir, recursive: true);
        }
        catch (IOException) { /* best-effort; temp file will remain on disk */ }
        catch (UnauthorizedAccessException) { /* Windows file lock (AV/game); temp file will remain */ }
    }
}
