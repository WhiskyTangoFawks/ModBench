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

    // RelativePathOf answers a flat record's would-be path when its file is gone; DocumentOf
    // answers only a file that is there.
    internal static bool Places(
        PluginAddress plugin, RecordIdentity identity, ISourceRepositoryReads repository,
        [NotNullWhen(true)] out string? file, [NotNullWhen(false)] out string? failure)
    {
        var placed = repository.DocumentOf(plugin, identity)
            .Then(document => document is null ? SourceAnswer.Of<string?>(null) : repository.RelativePathOf(plugin, identity));
        if (!placed.Holds(out var path, out var unread))
            (file, failure) = (null, $"{plugin.Name}'s source could not place {identity.FormKey}: {unread.Reason}");
        else if (path is null)
            (file, failure) = (null, $"{plugin.Name}'s source holds no file for {identity.FormKey}.");
        else
            (file, failure) = (path, null);
        return file is not null;
    }

    internal static MissingReferenceOnFile Unprovided(MissingReference reference) =>
        Failed(reference, ReadFailures.NoModFolder(reference.Plugin.Name));

    private static MissingReferenceOnFile Failed(MissingReference reference, string failure) => new(reference, null, failure);
}
