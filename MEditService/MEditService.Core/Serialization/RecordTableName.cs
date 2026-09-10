using System.Reflection;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Serialization;

/// <summary>Which schema table a record belongs to: the table whose type it is one of, else the GRUP
/// signature the schema names tables after, else the CLR type name lowercased.</summary>
internal static class RecordTableName
{
    internal static string Of(IMajorRecordGetter record, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Of(record.GetType(), schemas);

    /// <summary>Empty for a type nothing resolved, so a caller that could not name the document's
    /// class gets no table rather than a guessed one.</summary>
    internal static string Of(Type? concrete, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (concrete == null) return string.Empty;

        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsAssignableFrom(concrete)) return tableName;
        }

        // A table built from several concrete classes (Globals) binds its RecordType to whichever
        // was discovered first, so a sibling matches nothing above — and the GRUP signature the
        // schema names that table after is on the record's own class.
        return GrupSignatureOf(concrete) ?? concrete.Name.ToLowerInvariant();
    }

    private static string? GrupSignatureOf(Type type) =>
        type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static)?.GetValue(null)
            is RecordType grup
            ? grup.Type.ToLowerInvariant()
            : null;
}
