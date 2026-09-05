using System.Globalization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Mutagen.Bethesda.Strings.DI;

namespace MEditService.Core.Edits;

/// <summary>Writes a plugin binary: sibling temp file, commit by rename, timestamped <c>.bak</c>
/// beside it (ADR-0008), oldest pruned. Mechanism only, no edit semantics.</summary>
public sealed class PluginWriter(ILogger<PluginWriter> logger)
{
    private const int MaxBackups = 5;

    private readonly ILogger<PluginWriter> _logger = logger;

    /// <summary><paramref name="loadOrder"/> orders the written master list explicitly (ADR-0038,
    /// xEdit's canonical form) rather than leaving it to Mutagen's undefined default.</summary>
    public static Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        GameRelease gameRelease,
        IReadOnlyList<string>? loadOrder = null)
    {
        var modKey = ModKey.FromFileName(Path.GetFileName(pluginPath));
        // No load order concept here, so no origin to distinguish a mod folder from the game Data folder:
        // the single-argument ForRead overload applies.
        var mod = ModFactory.ImportSetter(new ModPath(modKey, pluginPath), gameRelease, LocalizedStrings.ForRead(Path.GetDirectoryName(pluginPath)!));
        return PrepareFromModAsync(mod, pluginPath, loadOrder);
    }

    /// <summary>Writes an already-assembled mod: compile's mod comes from the source tree, never off
    /// the binary it replaces. <paramref name="pluginPath"/> still supplies the backup and destination.</summary>
    public static async Task<PreparedPluginSave> PrepareFromModAsync(
        IMod mod,
        string pluginPath,
        IReadOnlyList<string>? loadOrder = null)
    {
        var backupPath = CreateBackup(pluginPath);

        var dir = Path.GetDirectoryName(pluginPath)!;
        var tmpDir = Path.Combine(dir, ".medit_tmp_" + Path.GetRandomFileName());
        var tmpPath = Path.Combine(tmpDir, Path.GetFileName(pluginPath));
        Directory.CreateDirectory(tmpDir);

        // Cleanup is catch-and-rethrow, not finally: tmpDir must survive a successful return (Commit still
        // needs tmpPath), and a throw from WriteAsync (github.com/Mutagen-Modding/Mutagen/issues/688) leaves no
        // PreparedPluginSave to Dispose it.
        try
        {
            // ADR-0042: the header's stored NextObjectID and record count are written as stored, never
            // recomputed. Mutagen's Iterate defaults re-derive both, and real override plugins routinely
            // carry stored values that match neither.
            var writeBuilder = mod.BeginWrite
                .ToPath(tmpPath)
                .WithLoadOrderFromHeaderMasters()
                .WithNoDataFolder()
                .NoNextFormIDProcessing()
                .WithRecordCount(RecordCountOption.NoCheck);

            // Mutagen's default StringsWriter derives its folder from the write path, which is the temp path
            // here; supplying one nested inside tmpDir gives strings files the same temp-write-then-rename
            // discipline as the binary.
            var tmpStringsDir = Path.Combine(tmpDir, "Strings");
            if (mod.UsingLocalization)
            {
                writeBuilder = writeBuilder.WithStringsWriter(new StringsWriter(
                    mod.GameRelease, mod.ModKey,
                    writeDirectory: tmpStringsDir,
                    encodingProvider: MutagenEncoding.Default));
            }

            // ADR-0038: masters are ordered explicitly from the load order when supplied, so the written
            // file's master list matches what xEdit shows (ADR-0034 at the file level).
            if (loadOrder != null)
                writeBuilder = writeBuilder.WithMastersListOrdering(loadOrder.Select(name => ModKey.FromFileName(name)));

            await writeBuilder.WriteAsync();

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
        using var prep = await PrepareAsync(pluginPath, gameRelease, loadOrder);
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
        using var prep = await PrepareFromModAsync(mod, pluginPath, loadOrder);
        prep.Commit();
        PruneOldBackups(pluginPath);
        return prep.BackupPath;
    }

    // Sub-second timestamps: one gesture can write a plugin twice in a second and the second backup
    // collided. Not a uniquifying retry, which would mask a genuine collision, nor overwrite, which
    // destroys the earlier backup.
    internal static string CreateBackup(string pluginPath, string? timestamp = null)
    {
        var dir = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext = Path.GetExtension(pluginPath);
        var ts = timestamp ?? DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffffff", CultureInfo.InvariantCulture);
        var path = Path.Combine(dir, $"{name}.{ts}.bak{ext}");
        File.Copy(pluginPath, path, overwrite: false);
        return path;
    }

    internal void PruneOldBackups(string pluginPath)
    {
        var dir = Path.GetDirectoryName(pluginPath)!;
        var name = Path.GetFileNameWithoutExtension(pluginPath);
        var ext = Path.GetExtension(pluginPath);

        var old = Directory.GetFiles(dir, $"{name}.*.bak{ext}")
            .OrderByDescending(f => f)
            .Skip(MaxBackups);

        foreach (var f in old)
        {
            try { File.Delete(f); }
            catch (Exception ex) { _logger.LogWarning(ex, "Failed to delete old backup {File}", f); }
        }
    }
}
