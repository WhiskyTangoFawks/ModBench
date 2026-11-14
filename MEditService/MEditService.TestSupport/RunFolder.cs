namespace MEditService.TestSupport;

/// <summary>A folder at one fixed path in the temp folder, so a run killed part-way leaves at most one behind for the
/// next write to clear.</summary>
public sealed class RunFolder : IDisposable
{
    public string Path { get; }

    private RunFolder(string path) => Path = path;

    public static RunFolder Written(string name, Action<string> write)
    {
        var folder = new RunFolder(System.IO.Path.Combine(System.IO.Path.GetTempPath(), name));
        folder.Dispose();
        Directory.CreateDirectory(folder.Path);
        try
        {
            write(folder.Path);
            return folder;
        }
        catch
        {
            folder.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        if (Directory.Exists(Path)) AnotherTool.Delete(Path);
    }
}
