using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>Record types with a group folder of their own to be placed into, and no child records of
/// their own to place a new record into — a container's, embedded or not, is excluded either way.</summary>
public static class CreatableRecordTypes
{
    public static IEnumerable<string> Of(IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release) =>
        schemas.Keys.Where(type => Includes(type, release));

    public static bool Includes(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).FolderNameFor(recordType) is not null
        && !ContainerChildFields.HasChildFields(recordType, release);
}
