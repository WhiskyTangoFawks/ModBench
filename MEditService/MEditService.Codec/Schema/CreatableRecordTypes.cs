using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>The game's flat record types, each with a group folder of its own: a container record,
/// or a record one holds, has no containment a new record could be placed into.</summary>
public static class CreatableRecordTypes
{
    public static IEnumerable<string> Of(IReadOnlyDictionary<string, RecordTableSchema> schemas, GameRelease release)
    {
        var dispatch = RecordTypeDispatch.For(release);
        return schemas.Keys.Where(type => dispatch.FolderNameFor(type) is not null);
    }
}
