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

/// <summary>
/// Writes a plugin binary: import, write to a sibling temp file, commit by rename, drop a
/// timestamped <c>.bak</c> beside it (ADR-0008), prune the oldest.
///
/// Mechanism only, no edit semantics: ADR-0041's Save &amp; Compile serializes a working tree into
/// a mod and hands it here to become bytes on disk.
///
/// The binary round-trip stability gate runs through <see cref="SaveAsync"/> and stays the
/// permanent guard on it.
/// </summary>
public sealed class PluginWriter(ILogger<PluginWriter> logger)
{
    private const int MaxBackups = 5;

    private readonly ILogger<PluginWriter> _logger = logger;

    /// <summary>
    /// Imports the plugin at <paramref name="pluginPath"/> and writes it back out to a temp file,
    /// returning the uncommitted result. <paramref name="loadOrder"/> (ADR-0038): plugin
    /// filenames in the load order's current load order, used to order the written master list
    /// explicitly (xEdit-familiar canonical form on disk — ADR-0034 at the file level) rather than
    /// leaving it to Mutagen's undefined default. Optional, because PluginWriter has no load order
    /// concept of its own.
    /// </summary>
    public static Task<PreparedPluginSave> PrepareAsync(
        string pluginPath,
        GameRelease gameRelease,
        IReadOnlyList<string>? loadOrder = null)
    {
        var modKey = ModKey.FromFileName(Path.GetFileName(pluginPath));
        // Same explicit strings parameters every other deep-parse call site builds. This
        // method has no load order concept of its own (see its own doc comment) and so no origin to
        // distinguish a mod folder from the game Data folder — the single-argument ForRead overload
        // applies, the same as ExternalChangeAbsorber/ExternalChangeEditLander's identical call.
        var mod = ModFactory.ImportSetter(new ModPath(modKey, pluginPath), gameRelease, LocalizedStrings.ForRead(Path.GetDirectoryName(pluginPath)!));
        return PrepareFromModAsync(mod, pluginPath, loadOrder);
    }

    /// <summary>
    /// <see cref="PrepareAsync"/>'s other half: writes an already-assembled <paramref name="mod"/>
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

        // Everything from here down can throw before this method ever returns a
        // PreparedPluginSave — most concretely, a plugin whose only reference to a master lives in
        // a VMAD struct-list script property (Mutagen-Modding/Mutagen#688) throws
        // UnmappableFormIDException out of WriteAsync below, on every retry, for as long as that
        // plugin stays broken. PreparedPluginSave.Dispose() is what normally deletes tmpDir, but a
        // Dispose that never gets constructed never runs — the caller's `using` has nothing to bind
        // when this method itself throws. Same discipline TrackService.VerifyRoundTrip already uses
        // for its own scratch directory, adapted for the one difference that matters here: tmpDir
        // must survive a *successful* return (Commit() still needs tmpPath), so cleanup is
        // catch-and-rethrow, not an unconditional finally. The .bak stays untouched either way
        // (ADR-0008) — a write that never happened is a different question from a write that did,
        // and the ADR does not decide it, so this method doesn't either.
        try
        {
            // ADR-0042: HEDR.NextObjectID and HEDR.NumRecords are written verbatim from the mod's
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

            // A Localized mod's own strings must land beside the *real* plugin, not
            // orphaned in the temp directory this method discards — but not written directly to their
            // real destination either. Mutagen's own default (PluginUtilityTranslation.SetStringsWriter,
            // which only fires when nothing here supplies one) derives its write folder from the write
            // path — the temp path here — which is why a writer must be supplied explicitly at all.
            // That writer's own folder nests inside the same tmpDir the plugin binary already
            // writes to, rather than pointing at pluginPath's real Strings/ folder directly: the real
            // .esp/.esm gets the same temp-write-then-rename discipline from PreparedPluginSave.Commit,
            // and the strings files now get it too, moved into place only once every write here has
            // succeeded.
            var tmpStringsDir = Path.Combine(tmpDir, "Strings");
            if (mod.UsingLocalization)
            {
                writeBuilder = writeBuilder.WithStringsWriter(new StringsWriter(
                    mod.GameRelease, mod.ModKey,
                    writeDirectory: tmpStringsDir,
                    encodingProvider: MutagenEncoding.Default));
            }

            // ADR-0038: masters are wholly content-derived, unconditionally, on every write —
            // Mutagen's default MastersListContentOption.Iterate. Ordering is explicit rather than left
            // to Mutagen's default (alphabetical, masters-first): the load order's current load order when
            // supplied, so the written file's master list matches what a modder opening it in xEdit
            // afterward expects (ADR-0034 at the file level).
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
            // The cleanup below is a courtesy, never allowed to outrank the exception it's cleaning
            // up after: a failed WriteAsync can plausibly leave a file handle open on tmpDir (Mutagen's
            // writer or the StringsWriter not having released it on the throwing path), and a locked
            // directory is exactly when Directory.Delete itself throws — if that escaped unguarded it
            // would replace the real exception (UnmappableFormIDException, the one
            // PluginDiagnosis.HasUnmappableFormID and every catch downstream is built to recognize)
            // with a confusing IOException about a temp directory, exactly when the filesystem is
            // uncooperative. This method is static, so
            // there is no ILogger in scope to note the failed cleanup with; an orphaned tmpDir is
            // strictly better than losing the diagnosis, so it is swallowed rather than escalated.
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

    /// <summary><see cref="SaveAsync"/>'s <see cref="PrepareFromModAsync"/> counterpart — Save &amp;
    /// Compile's own entry point.</summary>
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
