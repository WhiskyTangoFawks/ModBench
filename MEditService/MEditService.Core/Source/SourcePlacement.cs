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
    /// Cell nested under block/sub-block, the only reason <paramref name="blockPath"/> exists. An
    /// embedded child lands inside its container's document instead.</summary>
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
                $"'{recordType}' has no group folder at all — it is an embedded child, which lands inside " +
                "its container's document rather than at a path of its own.");

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
