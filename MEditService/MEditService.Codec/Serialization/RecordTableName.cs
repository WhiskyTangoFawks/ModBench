using System.Reflection;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>Which schema table a record belongs to: the table whose type it is one of, else the GRUP
/// signature the schema names tables after, else the CLR type name lowercased.</summary>
public static class RecordTableName
{
    public static string Of(IMajorRecordGetter record, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Of(record.GetType(), schemas);

    /// <summary>Empty for a type nothing resolved, so a caller that could not name the document's
    /// class gets no table rather than a guessed one.</summary>
    public static string Of(Type? concrete, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (concrete == null) return string.Empty;

        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsAssignableFrom(concrete)) return tableName;
        }

        // A table built from several concrete classes (Globals) binds its RecordType to whichever
        // was discovered first, so a sibling matches nothing above — and the GRUP signature the
        // schema names that table after is on the record's own class.
        return GrupSignatureOf(RecordClassOf(concrete)) ?? concrete.Name.ToLowerInvariant();
    }

    /// <summary>The record signature a table is named after: the table is its lowercase.</summary>
    public static string SignatureOf(string table) => table.ToUpperInvariant();

    private const string OverlaySuffix = "BinaryOverlay";

    // Mutagen names the class of a record read lazily from a plugin after the record's own class,
    // which alone declares the GRUP signature.
    private static Type RecordClassOf(Type type) =>
        type.Name.EndsWith(OverlaySuffix, StringComparison.Ordinal)
        && type.Assembly.GetType($"{type.Namespace}.{type.Name[..^OverlaySuffix.Length]}") is { } recordClass
            ? recordClass
            : type;

    /// <summary>Every concrete record class <paramref name="gameAssembly"/> registers under a GRUP,
    /// with the table its GRUP signature names.</summary>
    internal static IEnumerable<(Type RecordClass, string Table)> GrupRecordClassesIn(Assembly gameAssembly)
    {
        foreach (var type in gameAssembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface || !typeof(IMajorRecordGetter).IsAssignableFrom(type)) continue;
            if (GrupSignatureOf(type) is { } table) yield return (type, table);
        }
    }

    private static string? GrupSignatureOf(Type type) =>
        type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static) is { } grup
            ? ((RecordType)(grup.GetValue(null)
                ?? throw new InvalidOperationException($"Expected '{type.Name}.GrupRecordType' to hold a value."))).Type.ToLowerInvariant()
            : null;
}
