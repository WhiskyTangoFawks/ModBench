namespace MEditService.Core.Edits;

public sealed class PreparedPluginSave(string tmpPath, string finalPath, SaveResult result) : IDisposable
{
    private string? _backupPath;

    public SaveResult Result => result;

    public void Commit()
    {
        _backupPath = finalPath + ".medit-rollback";
        // overwrite:true so a stale backup left behind by a prior crash doesn't permanently
        // block saves of this plugin
        File.Move(finalPath, _backupPath, overwrite: true);
        File.Move(tmpPath, finalPath, overwrite: true);
    }

    // Undoes a completed Commit(): restores the pre-save file and drops the phantom
    // user-facing .bak that PrepareAsync already created for this now-abandoned attempt.
    public void Rollback()
    {
        if (_backupPath == null) return;
        File.Move(_backupPath, finalPath, overwrite: true);
        _backupPath = null;
        if (!string.IsNullOrEmpty(result.BackupPath) && File.Exists(result.BackupPath))
            File.Delete(result.BackupPath);
    }

    public void Dispose()
    {
        try
        {
            if (_backupPath != null) File.Delete(_backupPath); // committed but never rolled back; best-effort
            File.Delete(tmpPath); // no-op if already moved
            var tmpDir = Path.GetDirectoryName(tmpPath)!;
            if (Directory.Exists(tmpDir))
                Directory.Delete(tmpDir);
        }
        catch (IOException) { /* best-effort; temp file will remain on disk */ }
        catch (UnauthorizedAccessException) { /* Windows file lock (AV/game); temp file will remain */ }
    }
}
