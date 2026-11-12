using System.Diagnostics.CodeAnalysis;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex;

/// <summary>A <see cref="MissingReference"/> with its referring record's file, relative to the source
/// folder. <paramref name="Failure"/> says why the tree names none: a file changed outside Modbench.</summary>
internal sealed record MissingReferenceOnFile(MissingReference Reference, string? SourceRelativePath, string? Failure);

internal static class SourceFilePlacement
{
    internal static MissingReferenceOnFile Place(MissingReference reference, ISourceRepositoryReads repository)
    {
        var identity = new RecordIdentity(reference.FormKey, reference.RecordType, reference.EditorId);
        return Places(reference.Plugin, identity, repository, out var path, out var failure)
            ? new(reference, path, null)
            : new(reference, null, failure);
    }

    internal static bool Places(
        PluginAddress plugin, RecordIdentity identity, ISourceRepositoryReads repository,
        [NotNullWhen(true)] out string? file, [NotNullWhen(false)] out string? failure)
    {
        if (!repository.DocumentOf(plugin, identity).Holds(out var document, out var unread))
            (file, failure) = (null, $"{plugin.Name}'s source could not place {identity.FormKey}: {unread.Reason}");
        else if (document is null)
            (file, failure) = (null, $"{plugin.Name}'s source holds no file for {identity.FormKey}.");
        else
            (file, failure) = (document.RelativePath, null);
        return file is not null;
    }

    internal static MissingReferenceOnFile Unprovided(MissingReference reference) =>
        Failed(reference, ReadFailures.NoModFolder(reference.Plugin.Name));

    private static MissingReferenceOnFile Failed(MissingReference reference, string failure) => new(reference, null, failure);
}
