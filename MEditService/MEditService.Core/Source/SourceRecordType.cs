using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>A record's source record-type folder name, resolved the same way
/// <c>DuckDbRecordIndex.ResolveRecordType</c> does: schema table name by type match, else the CLR
/// type name lowercased.</summary>
internal static class SourceRecordType
{
    internal static string Resolve(IMajorRecordGetter record, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsInstanceOfType(record)) return tableName;
        }

        return record.GetType().Name.ToLowerInvariant();
    }
}
