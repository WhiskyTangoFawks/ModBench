namespace MEditService.TestSupport;

/// <summary>A folder at one fixed path in the temp folder, so a run killed part-way leaves at most one behind for the
/// next write to clear. One run holds it at a time.</summary>
public sealed class RunFolder : IDisposable
{
    private readonly FileStream _held;

    public string Path { get; }

    private RunFolder(string path)
    {
        Path = path;
        _held = Hold(path);
    }

    public static RunFolder Written(string name, Action<string> write)
    {
        var folder = new RunFolder(System.IO.Path.Combine(System.IO.Path.GetTempPath(), name));
        try
        {
            if (Directory.Exists(folder.Path)) AnotherTool.Delete(folder.Path);
            Directory.CreateDirectory(folder.Path);
            write(folder.Path);
            return folder;
        }
        catch
        {
            folder.Dispose();
            throw;
        }
    }

    private static FileStream Hold(string path)
    {
        try
        {
            return new FileStream($"{path}.lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException ex)
        {
            throw new IOException($"Another run holds {path}; this run would clear it beneath that one.", ex);
        }
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(Path)) AnotherTool.Delete(Path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Windows refuses to delete a file a process still holds; the next write clears it.
        }
        finally
        {
            _held.Dispose();
        }
    }
}
