namespace MEditService.PluginAdapter;

/// <summary>An uncommitted plugin write: temp-written binary and strings files plus the <c>.bak</c>
/// already made. Commit renames them into place; Dispose discards the temp state either way.</summary>
public sealed class PreparedPluginSave(
    string tmpPath,
    string finalPath,
    string backupPath,
    IReadOnlyList<(string TempPath, string FinalPath)>? stringsFiles = null) : IDisposable
{
    private readonly IReadOnlyList<(string TempPath, string FinalPath)> _stringsFiles = stringsFiles ?? [];
    private string? _rollbackPath;

    /// <summary>The timestamped user-facing <c>.bak</c> this attempt created.</summary>
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

        // Every strings write succeeded during Prepare, so Commit is pure rename. Overwrite, because a
        // re-save of the same Localized plugin is the common case, not the first.
        foreach (var (tempStringsPath, finalStringsPath) in _stringsFiles)
        {
            Directory.CreateDirectory(PathShape.DirectoryOf(finalStringsPath));
            File.Move(tempStringsPath, finalStringsPath, overwrite: true);
        }
    }

    public void Dispose()
    {
        try
        {
            if (_rollbackPath != null) File.Delete(_rollbackPath); // committed but never rolled back; best-effort
            File.Delete(tmpPath); // no-op if already moved
            var tmpDir = PathShape.DirectoryOf(tmpPath);
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
