using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

public interface ISchemaReflector
{
    IReadOnlyDictionary<string, RecordTableSchema> GetSchemas(GameRelease release);
}
