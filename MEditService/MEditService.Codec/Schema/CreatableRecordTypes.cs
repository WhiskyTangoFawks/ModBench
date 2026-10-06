using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>Record types with a top-level group of their own to be placed into. A type the game holds
/// only inside another record has none.</summary>
public static class CreatableRecordTypes
{
    public static IEnumerable<string> Of(IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release) =>
        schemas.Keys.Where(type => Includes(type, release));

    public static bool Includes(string recordType, GameRelease release) =>
        RecordTypeDispatch.For(release).GroupFolderNameFor(recordType) is not null;
}
