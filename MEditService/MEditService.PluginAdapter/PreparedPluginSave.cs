namespace MEditService.PluginAdapter;

/// <summary>An uncommitted plugin write: temp-written binary and strings files. Commit renames them
/// into place; Dispose discards the temp state either way.</summary>
public sealed class PreparedPluginSave : IDisposable
{
    private readonly string _tmpDir;
    private readonly string _tmpPath;
    private readonly string _finalPath;
    private readonly IReadOnlyList<(string TempPath, string FinalPath)> _stringsFiles;

    internal PreparedPluginSave(
        string tmpDir, string tmpPath, string finalPath, IReadOnlyList<(string TempPath, string FinalPath)>? stringsFiles = null)
    {
        _tmpDir = tmpDir;
        _tmpPath = tmpPath;
        _finalPath = finalPath;
        _stringsFiles = stringsFiles ?? [];
    }

    /// <summary>The hash of the binary Commit puts in place, spelled as the commit trailers spell it.</summary>
    public string BinarySha256() => PluginBinaryHash.TrailerFormOfFile(_tmpPath);

    /// <summary>The strings first and the binary last, each by one rename over the old file, so an
    /// interrupted commit leaves the old binary or the new one (plugins.md, Compile, story 5).</summary>
    public void Commit()
    {
        foreach (var (tempStringsPath, finalStringsPath) in _stringsFiles)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(finalStringsPath)
                ?? throw new InvalidOperationException($"Expected '{finalStringsPath}' to have a parent directory."));
            File.Move(tempStringsPath, finalStringsPath, overwrite: true);
        }
        File.Move(_tmpPath, _finalPath, overwrite: true);
    }

    public void Dispose()
    {
        try
        {
            // Recursive: tmpDir can still hold the Strings/ temp subfolder, whole after an uncommitted
            // Dispose, part-drained after a Commit that threw partway through the strings.
            if (Directory.Exists(_tmpDir))
                Directory.Delete(_tmpDir, recursive: true);
        }
        catch (IOException) { /* best-effort; temp file will remain on disk */ }
        catch (UnauthorizedAccessException) { /* Windows file lock (AV/game); temp file will remain */ }
    }
}
