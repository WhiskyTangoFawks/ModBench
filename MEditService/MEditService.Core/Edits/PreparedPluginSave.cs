namespace MEditService.Core.Edits;

public sealed class PreparedPluginSave(string tmpPath, string finalPath, SaveResult result) : IDisposable
{
    public SaveResult Result => result;

    public void Commit() => File.Move(tmpPath, finalPath, overwrite: true);

    public void Dispose()
    {
        try
        {
            File.Delete(tmpPath); // no-op if already moved
            var tmpDir = Path.GetDirectoryName(tmpPath)!;
            if (Directory.Exists(tmpDir))
                Directory.Delete(tmpDir);
        }
        catch (IOException) { /* best-effort; temp file will remain on disk */ }
        catch (UnauthorizedAccessException) { /* Windows file lock (AV/game); temp file will remain */ }
    }
}
