using System.Globalization;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>Replaces a plugin binary: sibling temp file, commit by rename, timestamped <c>.bak</c>
/// beside it, oldest pruned. Mechanism only, no edit semantics.</summary>
public sealed class PluginWriter(ILogger<PluginWriter> logger, TimeProvider? timeProvider = null)
{
    private const int MaxBackups = 5;

    private readonly ILogger<PluginWriter> _logger = logger;
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

    // loadOrder orders the written master list explicitly, so the file matches what xEdit shows,
    // rather than leaving the order to Mutagen's undefined default.
    private static Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        GameRelease gameRelease,
        IReadOnlyList<string>? loadOrder = null,
        TimeProvider? timeProvider = null)
    {
        // No load order concept here, so no origin to distinguish a mod folder from the game Data folder:
        // the single-argument ForRead overload applies. The path names its own ModKey.
        var mod = MutagenPluginAdapter.OpenForWrite(
            new ModPath(pluginPath), gameRelease, PluginStrings.In(PathShape.DirectoryOf(pluginPath)));
        return PrepareFromModAsync(mod, pluginPath, loadOrder, timeProvider);
    }

    /// <summary>Writes an already-assembled mod: compile's mod comes from the source tree, never off
    /// the binary it replaces. <paramref name="pluginPath"/> still supplies the backup and destination.</summary>
    public static async Task<PreparedPluginSave> PrepareFromModAsync(
        IMod mod,
        string pluginPath,
        IReadOnlyList<string>? loadOrder = null,
        TimeProvider? timeProvider = null)
    {
        var backupPath = CreateBackup(pluginPath, timeProvider: timeProvider);

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

            return new PreparedPluginSave(tmpPath, pluginPath, backupPath, stringsFiles);
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

    /// <summary>Prepare, commit, prune. Returns the path of the backup it created.</summary>
    public async Task<string> SaveAsync(
        string pluginPath,
        GameRelease gameRelease,
        IReadOnlyList<string>? loadOrder = null)
    {
        using var prep = await PrepareAsync(pluginPath, gameRelease, loadOrder, _timeProvider);
        prep.Commit();
        PruneOldBackups(pluginPath);
        return prep.BackupPath;
    }

    /// <summary>Save &amp; Compile's entry point: <see cref="SaveAsync"/> for an already-assembled mod.</summary>
    public async Task<string> SaveFromModAsync(
        IMod mod,
        string pluginPath,
        IReadOnlyList<string>? loadOrder = null)
    {
        using var prep = await PrepareFromModAsync(mod, pluginPath, loadOrder, _timeProvider);
        prep.Commit();
        PruneOldBackups(pluginPath);
        return prep.BackupPath;
    }

    // Sub-second timestamps: one gesture can write a plugin twice in a second and the second backup
    // collided. Not a uniquifying retry, which would mask a genuine collision, nor overwrite, which
    // destroys the earlier backup.
    internal static string CreateBackup(string pluginPath, TimeProvider? timeProvider = null)
    {
        var dir = PathShape.DirectoryOf(pluginPath);
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext = Path.GetExtension(pluginPath);
        var ts = (timeProvider ?? TimeProvider.System).GetUtcNow()
            .ToString("yyyy-MM-ddTHH-mm-ss-fffffff", CultureInfo.InvariantCulture);
        var path = Path.Combine(dir, $"{name}.{ts}.bak{ext}");
        File.Copy(pluginPath, path, overwrite: false);
        return path;
    }

    internal void PruneOldBackups(string pluginPath)
    {
        var dir = PathShape.DirectoryOf(pluginPath);
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext = Path.GetExtension(pluginPath);

        var old = Directory.GetFiles(dir, $"{name}.*.bak{ext}")
            .OrderByDescending(f => f)
            .Skip(MaxBackups);

        foreach (var f in old)
        {
            try { File.Delete(f); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Failed to delete old backup {File}", f);
            }
        }
    }
}
