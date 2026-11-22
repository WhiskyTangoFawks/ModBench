using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.PluginAdapter;

/// <summary>An uncommitted plugin write: temp-written binary and strings files. Commit renames them
/// into place; Dispose discards the temp state either way.</summary>
public sealed class PreparedPluginSave : IDisposable
{
    private readonly string _tmpDir;
    private readonly string _tmpPath;
    private readonly string _finalPath;
    private readonly IReadOnlyList<(string TempPath, string FinalPath)> _stringsFiles;
    private readonly IReadOnlyCache<IModMasterStyledGetter, ModKey>? _masterStyles;

    internal PreparedPluginSave(
        string tmpDir, string tmpPath, string finalPath, IReadOnlyList<(string TempPath, string FinalPath)> stringsFiles,
        IReadOnlyCache<IModMasterStyledGetter, ModKey>? masterStyles)
    {
        _tmpDir = tmpDir;
        _tmpPath = tmpPath;
        _finalPath = finalPath;
        _stringsFiles = stringsFiles;
        _masterStyles = masterStyles;
    }

    /// <summary>The temp-written binary read back with the temp strings and the master styles it was
    /// written with.</summary>
    internal IMod Reread(ModKey plugin, GameRelease release, Language language) =>
        MutagenPluginAdapter.OpenForWrite(new ModPath(plugin, _tmpPath), release, new PluginStrings([], [.. _stringsFiles.Select(file => new StampedFile(file.TempPath, Stamp: ""))]), _masterStyles, language);

    /// <summary>The hash of the binary Commit puts in place, spelled as the commit trailers spell it.</summary>
    public string BinarySha256() => PluginBinaryHash.TrailerFormOfFile(_tmpPath);

    /// <summary>The strings first, the binary last, each by one rename over the old file, so an interrupted commit leaves the
    /// old binary or the new one (plugins.md, Compile, story 5). <c>leaves</c> keeps a strings file.</summary>
    public void Commit(Func<string, bool> leaves)
    {
        foreach (var (tempStringsPath, finalStringsPath) in _stringsFiles)
        {
            if (leaves($"Strings/{Path.GetFileName(finalStringsPath)}")) continue;
            WrittenFiles.CreateDirectory(Path.GetDirectoryName(finalStringsPath)
                ?? throw new InvalidOperationException($"Expected '{finalStringsPath}' to have a parent directory."));
            File.Move(tempStringsPath, finalStringsPath, overwrite: true);
            WrittenFiles.Name(finalStringsPath);
        }
        File.Move(_tmpPath, _finalPath, overwrite: true);
        WrittenFiles.Name(_finalPath);
    }

    /// <summary>The binary put in place over no file, its name compared without case, as a plugin with no strings is: null,
    /// else the file at its path, named as spelled, and nothing written.</summary>
    public string? CommitOverNoFile()
    {
        if (PluginFolder.HeldAt(_finalPath) is { } held) return held;
        try
        {
            File.Move(_tmpPath, _finalPath, overwrite: false);
            WrittenFiles.Name(_finalPath);
            return null;
        }
        catch (IOException) when (File.Exists(_finalPath))
        {
            return PluginFolder.HeldAt(_finalPath) ?? Path.GetFileName(_finalPath);
        }
    }

    /// <summary>The binary put in place, the file of its name in any case first set aside in a new folder beside it: null,
    /// else why the file system refused, the file put back.</summary>
    public string? CommitSettingAside()
    {
        var folder = Path.GetDirectoryName(_finalPath) ?? throw new InvalidOperationException($"Expected '{_finalPath}' to have a parent directory.");
        var held = PluginFolder.HeldAt(_finalPath);
        var aside = held is null ? null : PluginFolder.Replaced.NewFolderIn(folder);
        try
        {
            if (held is not null && aside is not null)
            {
                Directory.CreateDirectory(aside);
                File.Move(Path.Combine(folder, held), Path.Combine(aside, held));
            }
            File.Move(_tmpPath, _finalPath, overwrite: false);
            WrittenFiles.Name(_finalPath);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            if (held is not null && aside is not null && Directory.Exists(aside))
            {
                if (File.Exists(Path.Combine(aside, held))) File.Move(Path.Combine(aside, held), Path.Combine(folder, held));
                Directory.Delete(aside);
            }
            return ex.Message;
        }
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
