using System.Globalization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>
/// Writes a plugin binary: import, write to a sibling temp file, commit by rename, drop a
/// timestamped <c>.bak</c> beside it (ADR-0008), prune the oldest.
///
/// #410/ADR-0041 reduced this to exactly that. Its other half — applying a list of
/// a change list to the imported mod (field, header, create, delete, renumber, VMAD and
/// condition paths, plus the read-only-field rule) — retired with the pending model it consumed.
/// What remains is the mechanism the text-first write path needs: ADR-0041's Save &amp; Compile
/// serializes a working tree into a mod and hands it here to become bytes on disk.
///
/// The #369 binary round-trip stability gate runs through <see cref="SaveAsync"/> and stays the
/// permanent guard on it.
/// </summary>
public sealed class PluginWriter(ILogger<PluginWriter> logger)
{
    private const int MaxBackups = 5;

    private readonly ILogger<PluginWriter> _logger = logger;

    /// <summary>
    /// Imports the plugin at <paramref name="pluginPath"/> and writes it back out to a temp file,
    /// returning the uncommitted result. <paramref name="loadOrder"/> (#337/ADR-0038): plugin
    /// filenames in the session's current load order, used to order the written master list
    /// explicitly (xEdit-familiar canonical form on disk — ADR-0034 at the file level) rather than
    /// leaving it to Mutagen's undefined default. Optional, because PluginWriter has no session
    /// concept of its own.
    /// </summary>
    public static Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        GameRelease gameRelease,
        IReadOnlyList<string>? loadOrder = null)
    {
        var modKey = ModKey.FromFileName(Path.GetFileName(pluginPath));
        var mod = ModFactory.ImportSetter(new ModPath(modKey, pluginPath), gameRelease);
        return PrepareFromModAsync(mod, pluginPath, loadOrder);
    }

    /// <summary>
    /// <see cref="PrepareAsync"/>'s other half (#416): writes an already-assembled <paramref name="mod"/>
    /// rather than importing one from <paramref name="pluginPath"/> first — Save &amp; Compile's own
    /// entry point, since compile's mod is deserialized whole from the source tree
    /// (<see cref="PluginCompileService"/>), never read off the binary it is about to replace.
    /// <paramref name="pluginPath"/> is still where the backup comes from and where the result lands.
    /// </summary>
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

        // #506/ADR-0042: HEDR.NextObjectID and HEDR.NumRecords are written verbatim from the mod's
        // own header, never recomputed. Mutagen's defaults (NextFormIDOption.Iterate,
        // RecordCountOption.Iterate) re-derive both from the record set — NextObjectID as max
        // self-authored FormID + 1 (or the game's initial value when there are none) — and real-world
        // override/patch plugins routinely carry stored values that match neither (nothing in-game
        // reads either field), so the defaults silently rewrite them on every save. No production
        // path allocates a new FormKey today (the only AddNew is source deserialization, with the
        // source's own key); one that does must allocate through Mutagen's GetNextFormKey, which
        // advances the in-memory header, so the value written here keeps up.
        var writeBuilder = mod.BeginWrite
            .ToPath(tmpPath)
            .WithLoadOrderFromHeaderMasters()
            .WithNoDataFolder()
            .NoNextFormIDProcessing()
            .WithRecordCount(RecordCountOption.NoCheck);

        // #337/ADR-0038: masters are wholly content-derived, unconditionally, on every write —
        // Mutagen's default MastersListContentOption.Iterate. Ordering is explicit rather than left
        // to Mutagen's default (alphabetical, masters-first): the session's current load order when
        // supplied, so the written file's master list matches what a modder opening it in xEdit
        // afterward expects (ADR-0034 at the file level).
        if (loadOrder != null)
            writeBuilder = writeBuilder.WithMastersListOrdering(loadOrder.Select(name => ModKey.FromFileName(name)));

        await writeBuilder.WriteAsync();

        return new PreparedPluginSave(tmpPath, pluginPath, backupPath);
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

    /// <summary><see cref="SaveAsync"/>'s <see cref="PrepareFromModAsync"/> counterpart — Save &amp;
    /// Compile's own entry point (#416).</summary>
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

    // The timestamp resolves to sub-second because one user gesture can write a plugin more than
    // once a second. At one-second resolution the second of those collided with the first's backup
    // and threw, failing the save. Sub-second keeps every backup — deliberately not
    // File.Copy(overwrite: true), which would destroy the earlier one, nor a uniquifying retry,
    // which would silently mask a genuine collision; CreateBackup_FileAlreadyExists_ThrowsIOException
    // pins that throw.
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
