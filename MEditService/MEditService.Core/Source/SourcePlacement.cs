using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>A record's place and the ordered child list naming it, derived together: derived apart, a
/// record can land in a directory whose list never names it, which the next read refuses
/// (ADR-0042 decision 4).</summary>
internal readonly record struct SourcePlacement(string RelativePath, string CarrierRelativePath, string Key)
{
    /// <summary>The three shapes with a group folder: flat file, container directory, and an interior
    /// Cell nested under block/sub-block — the only reason <paramref name="blockPath"/> exists. A
    /// folder-split child is <see cref="ForSlotChild"/>'s.</summary>
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
                $"'{recordType}' has no group folder at all — it is a folder-split child, whose directory " +
                $"belongs to its own parent's slot rather than to a group; use {nameof(ForSlotChild)}.");

        var leaf = SourceUnitResolver.LeafNameFor(FormKey.Factory(formKeyString), editorId, isDirectory: true);

        // Every block level the record nests under, if any. Only an interior Cell has them, and its
        // list belongs to the deepest one rather than to the group folder above them all.
        var carrierDirectory = Path.Combine([root, groupFolder, .. blockPath ?? []]);

        return new SourcePlacement(
            Path.Combine(carrierDirectory, leaf, SourceUnitResolver.RecordDataFileName),
            Path.Combine(carrierDirectory, SourceUnitResolver.GroupRecordDataFileName),
            blockPath is { Count: > 0 } ? RecordTypeDispatch.SubBlockChildMember : groupFolder);
    }

    /// <summary>No group folder: the child sits in a slot under its parent's directory, named by the
    /// parent's own document. <paramref name="parentDirectory"/> is absolute because a missing parent is
    /// minted by the caller first.</summary>
    internal static SourcePlacement ForSlotChild(
        string modFolder, string parentDirectory, string slotName, string formKeyString, string? editorId, bool isDirectory)
    {
        var leaf = SourceUnitResolver.LeafNameFor(FormKey.Factory(formKeyString), editorId, isDirectory);
        var own = isDirectory
            ? Path.Combine(parentDirectory, slotName, leaf, SourceUnitResolver.RecordDataFileName)
            : Path.Combine(parentDirectory, slotName, leaf);

        return new SourcePlacement(
            Path.GetRelativePath(modFolder, own),
            Path.GetRelativePath(modFolder, SourceChildOrder.CarrierFor(parentDirectory, parentIsRecord: true)),
            slotName);
    }
}
