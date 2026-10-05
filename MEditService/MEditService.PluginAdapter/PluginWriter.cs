using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>Replaces a plugin binary: sibling temp file, commit by rename. It keeps no copy of the
/// binary it replaces, since git keeps every state of the source (compile-plugin). Mechanism only.</summary>
public static class PluginWriter
{
    // loadOrder orders the written master list explicitly, so the file matches what xEdit shows,
    // rather than leaving the order to Mutagen's undefined default.
    private static Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        GameRelease gameRelease,
        IReadOnlyList<string>? loadOrder = null)
    {
        // No load order concept here, so no origin to distinguish a mod folder from the game Data folder:
        // the single-argument ForRead overload applies. The path names its own ModKey.
        var mod = MutagenPluginAdapter.OpenForWrite(
            new ModPath(pluginPath), gameRelease, PluginStrings.In(PathShape.DirectoryOf(pluginPath)));
        return PrepareFromModAsync(mod, pluginPath, loadOrder);
    }

    /// <summary>Writes an already-assembled mod: compile's mod comes from the source tree, never off
    /// the binary it replaces. <paramref name="pluginPath"/> still supplies the destination.</summary>
    public static async Task<PreparedPluginSave> PrepareFromModAsync(
        IMod mod,
        string pluginPath,
        IReadOnlyList<string>? loadOrder = null)
    {
        var dir = PathShape.DirectoryOf(pluginPath);
        var tmpDir = Path.Combine(dir, ".medit_tmp_" + Path.GetRandomFileName());
        var tmpPath = Path.Combine(tmpDir, Path.GetFileName(pluginPath));
        var tmpStringsDir = Path.Combine(tmpDir, "Strings");
        Directory.CreateDirectory(tmpDir);

        // Cleanup is catch-and-rethrow, not finally: tmpDir must survive a successful return (Commit still
        // needs tmpPath), and a throw from WriteAsync (Mutagen issue 688) leaves no
        // PreparedPluginSave to Dispose it.
        try
        {
            await MutagenPluginAdapter.WriteAsync(mod, tmpPath, loadOrder, tmpStringsDir);

            // Whatever StringsWriter actually produced (only present when UsingLocalization, and
            // only once WriteAsync's own StringsWriter.Dispose has run) rides to its real Strings/ folder
            // through Commit(), never written here directly.
            var stringsFiles = Directory.Exists(tmpStringsDir)
                ? Directory.GetFiles(tmpStringsDir)
                    .Select(f => (TempPath: f, FinalPath: Path.Combine(dir, "Strings", Path.GetFileName(f))))
                    .ToList()
                : [];

            return new PreparedPluginSave(tmpPath, pluginPath, stringsFiles);
        }
        catch
        {
            // Cleanup is a courtesy, never allowed to outrank the exception it follows: a locked temp
            // directory makes Directory.Delete throw, which would replace UnmappableFormIDException with an
            // IOException. No ILogger is in scope, so the failed cleanup is swallowed.
            try { Directory.Delete(tmpDir, recursive: true); }
            catch (IOException) { /* best-effort; tmpDir will remain on disk */ }
            catch (UnauthorizedAccessException) { /* Windows file lock (AV/game); tmpDir will remain */ }
            throw;
        }
    }

    /// <summary>Prepare, then commit.</summary>
    public static async Task SaveAsync(
        string pluginPath,
        GameRelease gameRelease,
        IReadOnlyList<string>? loadOrder = null)
    {
        using var prep = await PrepareAsync(pluginPath, gameRelease, loadOrder);
        prep.Commit();
    }
}
