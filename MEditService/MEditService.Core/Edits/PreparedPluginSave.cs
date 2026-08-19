namespace MEditService.Core.Edits;

public sealed class PreparedPluginSave(string tmpPath, string finalPath, string backupPath) : IDisposable
{
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
    }

    // Undoes a completed Commit(): restores the pre-save file and drops the phantom
    // user-facing .bak that PrepareAsync already created for this now-abandoned attempt.
    public void Rollback()
    {
        if (_rollbackPath == null) return;
        File.Move(_rollbackPath, finalPath, overwrite: true);
        _rollbackPath = null;
        // File.Delete no-ops on a missing path, so no need to check File.Exists first
        if (!string.IsNullOrEmpty(backupPath))
            File.Delete(backupPath);
    }

    public void Dispose()
    {
        try
        {
            if (_rollbackPath != null) File.Delete(_rollbackPath); // committed but never rolled back; best-effort
            File.Delete(tmpPath); // no-op if already moved
            var tmpDir = Path.GetDirectoryName(tmpPath)!;
            if (Directory.Exists(tmpDir))
                Directory.Delete(tmpDir);
        }
        catch (IOException) { /* best-effort; temp file will remain on disk */ }
        catch (UnauthorizedAccessException) { /* Windows file lock (AV/game); temp file will remain */ }
    }
}
