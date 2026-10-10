namespace MEditService.TestSupport;

public sealed class ScratchDirectory(string prefix) : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory(prefix).FullName;

    public static implicit operator string(ScratchDirectory scratch) => scratch.Path;

    public override string ToString() => Path;

    public void Dispose()
    {
        try { AnotherTool.Delete(Path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
