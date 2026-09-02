using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>
/// Where a record goes in the source tree, and which ordered child list names it there — answered
/// once, together, because they are one fact.
///
/// <para><b>Why one type rather than two helpers.</b> A structural write needs both halves and they
/// are not independent: the carrier that names a record is always the document above wherever the
/// record was placed, so a caller that derives the path from one rule and the key from another can
/// place a record in a directory whose list it never joins — which, under ADR-0042 decision 4's
/// asymmetric drift rule, is not a cosmetic mismatch but a tree the next read refuses outright.
/// Deriving them in one step makes the pair correct by construction instead of by everyone
/// remembering.</para>
///
/// <para>They were previously four helpers that had to agree without anything making them:
/// <see cref="SourceRecordPath.For"/> for flat records, two private path builders in
/// <c>RecordEditService</c> for containers, and a private key-chooser whose <c>isFlat</c> cascade
/// carried a stringly-typed <c>"cell"</c> override. Every call site picked its own pair, and the Cell
/// case picked differently from all the others.</para>
/// </summary>
/// <param name="RelativePath">The record's own file, relative to the mod folder — a flat record's
/// <c>.json</c>, or a container's <c>RecordData.json</c> inside its own directory.</param>
/// <param name="CarrierRelativePath">The document holding the ordered child list that must name this
/// record, relative to the mod folder.</param>
/// <param name="Key">The member name that list is carried under.</param>
internal readonly record struct SourcePlacement(string RelativePath, string CarrierRelativePath, string Key)
{
    /// <summary>
    /// The placement for a record about to be written.
    ///
    /// <para>Three shapes, and they are the whole taxonomy. A <b>flat</b> record is a file directly in
    /// its group folder, listed under the group's own name. A <b>top-level container</b> (Quest,
    /// Worldspace) is a directory in its group folder with its fields in <c>RecordData.json</c>,
    /// listed the same way. An <b>interior Cell</b> is the exception, and the only one: its directory
    /// nests under a block/sub-block pair, so the list naming it is the sub-block's own — which is why
    /// <paramref name="blockPath"/> exists and why nothing else needs it.</para>
    /// </summary>
    /// <param name="blockPath">The block and sub-block directory names an interior Cell nests under,
    /// in order. Required for a Cell and meaningless for anything else — a Cell's placement genuinely
    /// cannot be computed without knowing which bucket it lands in, and that choice belongs to the
    /// caller that already reuses or mints one.</param>
    internal static SourcePlacement For(
        string pluginFileName,
        string recordType,
        string formKeyString,
        string? editorId,
        GameRelease gameRelease,
        IReadOnlyList<string>? blockPath = null)
    {
        var dispatch = RecordTypeDispatch.For(gameRelease);
        var root = SourceRecordPath.RootFor(pluginFileName);

        // A flat record has a top-level group folder of its own and needs no directory.
        if (dispatch.FolderNameFor(recordType) is { } flatFolder)
        {
            return new SourcePlacement(
                SourceRecordPath.For(pluginFileName, recordType, formKeyString, editorId, gameRelease),
                Path.Combine(root, flatFolder, SourceUnitResolver.GroupRecordDataFileName),
                flatFolder);
        }

        var groupFolder = dispatch.GroupFolderNameFor(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no group folder at all, so it has no placement of its own — it is " +
                "a folder-split child, whose directory belongs to its own parent's slot rather than to " +
                "a group.");

        var leaf = SourceUnitResolver.LeafNameFor(FormKey.Factory(formKeyString), editorId, isDirectory: true);

        // Every block level the record nests under, if any. Only an interior Cell has them, and its
        // list belongs to the deepest one rather than to the group folder above them all.
        var carrierDirectory = Path.Combine([root, groupFolder, .. blockPath ?? []]);

        return new SourcePlacement(
            Path.Combine(carrierDirectory, leaf, SourceUnitResolver.RecordDataFileName),
            Path.Combine(carrierDirectory, SourceUnitResolver.GroupRecordDataFileName),
            blockPath is { Count: > 0 } ? RecordTypeDispatch.SubBlockChildMember : groupFolder);
    }

}
