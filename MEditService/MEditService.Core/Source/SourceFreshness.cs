using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>Re-checks source text before a read, not from a watcher: git is the change source and
/// moving HEAD touches no file. Both refs are re-derived, or Head would serve bytes no ref
/// holds.</summary>
public sealed class SourceFreshness(ILoadOrderMirror mirror, ILogger<SourceFreshness> logger, RecordTextCodec codec)
{
    // Needed to extract an embedded child's body out of its owner's document.
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
            try
            {
                ValidateOne(index, loadOrder, entry, stack.RecordType, formKey);
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

    private void ValidateOne(
        IRecordIndex index, ILoadOrder loadOrder, OverrideStackEntry entry, string recordType, string formKey)
    {
        if (ModFolders.TrackedOf(loadOrder, entry.Plugin) is not { } modFolder) return;

        var release = loadOrder.GameRelease;

        // The general resolver, not FlatSourcePath: a container or embedded child has no flat path, and
        // FlatSourcePath's NotSupportedException would become "serving the indexed state" — no check at all.
        var unit = SourceUnitResolver.Resolve(
            index.At(RecordRef.Effective), entry.Plugin, modFolder, formKey, recordType, entry.Effective.EditorId, release);

        // No unit anywhere means genuinely absent, with no path left even to guess at.
        string? fileText = null;
        if (unit is { } resolved)
        {
            var ownerBytes = File.Exists(resolved.FullPath) ? File.ReadAllBytes(resolved.FullPath) : null;
            fileText = RecordBodyFromOwnerBytes(ownerBytes, resolved, formKey, release);
        }

        if (!string.Equals(fileText, entry.Effective.Body, StringComparison.Ordinal))
        {
            // The file is the source for a tracked plugin, so whatever it says now is Effective, null included.
            // The gate wraps only the fold-in: the read-and-compare above must not queue behind
            // in-flight edits.
            using (mirror.WriteGate.Enter())
            {
                index.ApplyWorkingTreeChanges(entry.Plugin, [(formKey, fileText)]);
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

        // Nothing left to ask git about when Resolve found no unit at all — fail closed rather than
        // consulting a path that was never real.
        if (unit is { } resolvedUnit)
            RebaselineIfHeadMoved(index, entry, modFolder, resolvedUnit, formKey, release);
    }

    // For an embedded child the bytes are the owner's whole document, so the child is located and
    // reserialized alone; comparing the owner's file to the child's body would read every child as changed.
    private string? RecordBodyFromOwnerBytes(byte[]? ownerBytes, SourceUnit unit, string formKey, GameRelease release)
    {
        if (ownerBytes == null) return null;

        // File.ReadAllText strips a UTF-8 BOM; raw bytes do not. Unstripped, a BOM-carrying file would
        // mismatch the codec's BOM-free text on every read forever, since the self-heal never converges.
        ownerBytes = StripUtf8Bom(ownerBytes);

        // A container's own file carries its children's ordered list as well as its fields (ADR-0042
        // decision 4); the body the index holds is the fields alone, so the compare sees the same.
        if (!unit.IsEmbedded) return SourceChildOrder.WithoutOrder(Encoding.UTF8.GetString(ownerBytes));

        var owner = _codec.DeserializeFromBytesAsync(ownerBytes, release, unit.OwnerRecordType).GetAwaiter().GetResult();
        if (ContainerChildFields.FindEmbeddedChild(owner, formKey) is not { } found) return null;

        var childBytes = _codec.SerializeToBytesAsync(found.Child, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(childBytes);
    }

    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    private static byte[] StripUtf8Bom(byte[] bytes) =>
        bytes.AsSpan(0, Math.Min(bytes.Length, Utf8Bom.Length)).SequenceEqual(Utf8Bom) ? bytes[Utf8Bom.Length..] : bytes;

    // Asked only for a record the index already believes dirty; a clean one's committed bytes are the
    // file's, so no git process starts. The unit tells a record's own file from an embedded child's owner.
    private void RebaselineIfHeadMoved(
        IRecordIndex index, OverrideStackEntry entry, string modFolder, SourceUnit unit, string formKey,
        GameRelease release)
    {
        var head = index.At(RecordRef.Head).GetDocument(formKey, entry.Plugin);
        if (head?.Body is not { } committedBody) return;

        var relativePath = unit.RelativePath;

        // The hash fast path is meaningless for an embedded child: the blob at relativePath is the owner's
        // whole document.
        if (!unit.IsEmbedded)
        {
            var hashes = SourceRepository.CommittedSourceHashes(modFolder, [relativePath]);
            if (hashes == null || !hashes.TryGetValue(relativePath.Replace('\\', '/'), out var headHash)) return;

            // Equality is conclusive; inequality only sends us to compare bytes, never an assertion of change.
            if (headHash == GitBlobHash.Of(Encoding.UTF8.GetBytes(committedBody))) return;
        }

        if (SourceRepository.ReadCommittedSourceText(modFolder, relativePath) is not { } headOwnerText) return;

        // Same BOM defence as RecordBodyFromOwnerBytes; \uFEFF spelled as an escape so no editor can mangle it.
        headOwnerText = headOwnerText.TrimStart('\uFEFF');

        // For an embedded child the HEAD text is the owner's document; a null means the owner's HEAD copy
        // does not carry this child, which leaves the committed baseline alone (fail closed).
        var headText = unit.IsEmbedded
            ? RecordBodyFromOwnerBytes(Encoding.UTF8.GetBytes(headOwnerText), unit, formKey, release)
            : SourceChildOrder.WithoutOrder(headOwnerText);
        if (headText is not { } resolvedHeadText) return;
        if (string.Equals(resolvedHeadText, committedBody, StringComparison.Ordinal)) return;

        // The gate wraps the write only; every early return above is a read.
        using (mirror.WriteGate.Enter())
            index.SetCommittedBaseline(entry.Plugin, [(formKey, resolvedHeadText)]);

        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.LogDebug(
                "HEAD moved under {FormKey} in {Plugin}; committed baseline re-established at read time",
                formKey, entry.Plugin.Name);
        }
    }
}
