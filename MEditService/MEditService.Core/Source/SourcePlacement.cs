using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>Where a record with a file of its own lands in the tree.</summary>
internal readonly record struct SourcePlacement(string RelativePath)
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

        // A flat record has a top-level group folder of its own and needs no directory.
        if (dispatch.FolderNameFor(recordType) is not null)
            return new SourcePlacement(SourceRecordPath.For(pluginFileName, recordType, formKeyString, editorId, gameRelease));

        var groupFolder = dispatch.GroupFolderNameFor(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no group folder at all — it is an embedded child, which lands inside " +
                "its container's document rather than at a path of its own.");

        var leaf = SourceUnitResolver.LeafNameFor(FormKey.Factory(formKeyString), editorId, isDirectory: true);

        return new SourcePlacement(Path.Combine(
            [SourceRecordPath.RootFor(pluginFileName), groupFolder, .. blockPath ?? [], leaf, SourceUnitResolver.RecordDataFileName]));
    }
}
