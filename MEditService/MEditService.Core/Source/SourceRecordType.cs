using System.Reflection;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins;
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

        // A table built from several concrete classes (Globals) binds its RecordType to whichever
        // was discovered first, so a sibling matches nothing above — and the GRUP signature the
        // schema names that table after is on the record's own class.
        return GrupSignatureOf(record.GetType()) ?? record.GetType().Name.ToLowerInvariant();
    }

    private static string? GrupSignatureOf(Type type) =>
        type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static)?.GetValue(null)
            is RecordType grup
            ? grup.Type.ToLowerInvariant()
            : null;
}
