using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A <see cref="MissingReference"/> with its referring record's file, relative to the mod
/// folder. <paramref name="Failure"/> says why the tree names none: a file changed outside Modbench.</summary>
internal sealed record MissingReferenceOnFile(MissingReference Reference, string? SourceRelativePath, string? Failure);

internal static class SourceFilePlacement
{
    internal static MissingReferenceOnFile Place(MissingReference reference, ISourceRepositoryReads repository)
    {
        var identity = new RecordIdentity(reference.FormKey, reference.RecordType, reference.EditorId);
        // RelativePathOf answers a flat record's would-be path when its file is gone; DocumentOf
        // answers only a file that is there.
        var placed = repository.DocumentOf(reference.Plugin, identity)
            .Then(file => file is null ? SourceAnswer.Of<string?>(null) : repository.RelativePathOf(reference.Plugin, identity));
        if (!placed.Holds(out var path, out var failure))
            return Failed(reference, $"{reference.Plugin.Name}'s source could not place {reference.FormKey}: {failure.Reason}");
        return path is not null
            ? new MissingReferenceOnFile(reference, path, null)
            : Failed(reference, $"{reference.Plugin.Name}'s source holds no file for {reference.FormKey}.");
    }

    internal static MissingReferenceOnFile Unprovided(MissingReference reference) =>
        Failed(reference, $"{reference.Plugin.Name} is tracked but no mod folder provides it.");

    private static MissingReferenceOnFile Failed(MissingReference reference, string failure) => new(reference, null, failure);
}
