using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>Re-checks source text before a read, not from a watcher: git is the change source and
/// moving HEAD touches no file. A peek; the write is <see cref="IRecordIndex.RefreshByKeys"/>
/// (ADR-0046).</summary>
public sealed class SourceFreshness(ILoadOrderMirror mirror, ILogger<SourceFreshness> logger, RecordTextCodec codec)
{
    // For the peek's embedded-child extraction, which mirrors what RefreshByKeys does for the write.
    private readonly RecordTextCodec _codec = codec;

    /// <summary>Safe for an unknown FormKey, an untracked plugin or no loaded backend: this runs on the
    /// read path, which must not throw because a mod folder vanished while the editor was open.</summary>
    public void Validate(string formKey)
    {
        var index = mirror.Index;
        var loadOrder = mirror.LoadOrder;
        if (index == null || loadOrder == null) return;

        var stack = index.At(RecordRef.Effective).GetOverrideStack(formKey);
        if (stack == null) return;

        foreach (var entry in stack.Entries)
        {
            if (ModFolders.TrackedOf(loadOrder, entry.Plugin) is not { } modFolder) continue;

            try
            {
                RefreshIfDrifted(index, loadOrder.GameRelease, entry, modFolder, formKey);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException
                or NotSupportedException or IndexWriteGateTimeoutException)
            {
                // A read degrades to "serve what we have", never fails: the folder vanished, a locked file, git
                // mid-rebase, a corrupt tree, or the write gate unavailable — nothing was written, so the
                // next read finds the same drift. Logged.
                logger.LogWarning(ex,
                    "Could not validate source freshness for {FormKey} in {Plugin}; serving the indexed state",
                    formKey, entry.Plugin.Name);
            }
        }
    }

    // Reads the file (and git, for the committed side) to decide whether anything has moved, then
    // hands the actual re-derivation to RefreshByKeys — never the push verbs, and never gated unless
    // a write is about to happen.
    private void RefreshIfDrifted(
        IRecordIndex index, GameRelease release, OverrideStackEntry entry, string modFolder, string formKey)
    {
        // The general resolver, not FlatSourcePath: a container or embedded child has no flat path, and
        // FlatSourcePath's NotSupportedException would become "serving the indexed state" — no check at all.
        var unit = SourceUnitResolver.Resolve(
            index.At(RecordRef.Effective), entry.Plugin, modFolder, formKey, entry.Effective.RecordType,
            entry.Effective.EditorId, release);

        if (!LooksDrifted(index, entry, modFolder, unit, formKey, release)) return;

        using (mirror.WriteGate.Enter())
        {
            index.RefreshByKeys(entry.Plugin, modFolder, [formKey]);
            // A read-time self-heal is still a mutation — the row it just folded in can newly (or cease to)
            // match an active filter, same as an explicit edit would.
            mirror.ReapplyFilter();
        }

        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "Source text for {FormKey} in {Plugin} changed outside Modbench; refreshed at read time",
                formKey, entry.Plugin.Name);
        }
    }

    // Read-only: whether the working tree or the committed ref now disagrees with what the index
    // holds. RefreshByKeys re-answers this itself before writing, so a stale "yes" here costs nothing.
    private bool LooksDrifted(
        IRecordIndex index, OverrideStackEntry entry, string modFolder, SourceUnit? unit, string formKey, GameRelease release)
    {
        string? fileText = null;
        if (unit is { } resolved)
        {
            var ownerBytes = File.Exists(resolved.FullPath) ? File.ReadAllBytes(resolved.FullPath) : null;
            fileText = SourceUnitResolver.RecordBodyFromOwnerBytes(ownerBytes, resolved, formKey, release, _codec);
        }

        if (!string.Equals(fileText, entry.Effective.Body, StringComparison.Ordinal)) return true;

        // Nothing left to ask git about when Resolve found no unit at all — fail closed rather than
        // consulting a path that was never real.
        return unit is { } resolvedUnit && HeadLooksMoved(index, entry, modFolder, resolvedUnit, formKey, release);
    }

    // Asked only for a record the index already believes dirty; a clean one's committed bytes are the
    // file's, so no git process starts. The unit tells a record's own file from an embedded child's owner.
    private bool HeadLooksMoved(
        IRecordIndex index, OverrideStackEntry entry, string modFolder, SourceUnit unit, string formKey, GameRelease release)
    {
        var head = index.At(RecordRef.Head).GetDocument(formKey, entry.Plugin);
        if (head?.Body is not { } committedBody) return false;

        var relativePath = unit.RelativePath;

        // The hash fast path is meaningless for an embedded child: the blob at relativePath is the owner's
        // whole document.
        if (!unit.IsEmbedded)
        {
            var hashes = SourceRepository.CommittedSourceHashes(modFolder, [relativePath]);
            if (hashes == null || !hashes.TryGetValue(relativePath.Replace('\\', '/'), out var headHash)) return false;

            // Equality is conclusive; inequality only sends us to compare bytes, never an assertion of change.
            if (headHash == GitBlobHash.Of(Encoding.UTF8.GetBytes(committedBody))) return false;
        }

        if (SourceRepository.ReadCommittedSourceText(modFolder, relativePath) is not { } headOwnerText) return false;

        // Same BOM defence as RecordBodyFromOwnerBytes.
        headOwnerText = headOwnerText.TrimStart('\uFEFF');

        var headText = unit.IsEmbedded
            ? SourceUnitResolver.RecordBodyFromOwnerBytes(Encoding.UTF8.GetBytes(headOwnerText), unit, formKey, release, _codec)
            : headOwnerText;
        return headText is { } resolvedHeadText && !string.Equals(resolvedHeadText, committedBody, StringComparison.Ordinal);
    }
}
