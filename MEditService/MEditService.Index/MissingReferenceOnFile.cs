using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A <see cref="MissingReference"/> with its referring record's file, relative to the mod
/// folder. <paramref name="Failure"/> says why the tree names none: a file changed outside Modbench.</summary>
internal sealed record MissingReferenceOnFile(MissingReference Reference, string? SourceRelativePath, string? Failure);

internal static class SourceFilePlacement
{
    internal static MissingReferenceOnFile Place(MissingReference reference, SourceRepository repository)
    {
        try
        {
            var identity = new RecordIdentity(reference.FormKey, reference.RecordType, reference.EditorId);
            // RelativePathOf answers a flat record's would-be path when its file is gone; FullPathOf
            // answers only a file that is there.
            return repository.FullPathOf(reference.Plugin, identity) is not null
                ? new MissingReferenceOnFile(reference, repository.RelativePathOf(reference.Plugin, identity), null)
                : Failed(reference, $"{reference.Plugin.Name}'s source holds no file for {reference.FormKey}.");
        }
        catch (InvalidOperationException ex)
        {
            return Failed(reference, $"{reference.Plugin.Name}'s source could not place {reference.FormKey}: {ex.Message}");
        }
    }

    private static MissingReferenceOnFile Failed(MissingReference reference, string failure) => new(reference, null, failure);
}
