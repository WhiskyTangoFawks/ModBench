using System.Reflection;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>The GRUP signature the schema names a record's table after.</summary>
internal static class RecordTableName
{
    /// <summary>The record signature a table is named after: the table is its lowercase.</summary>
    internal static string SignatureOf(string table) => table.ToUpperInvariant();

    /// <summary>Every concrete record class <paramref name="gameAssembly"/> registers under a GRUP,
    /// with the table its GRUP signature names.</summary>
    internal static IEnumerable<(Type RecordClass, string Table)> GrupRecordClassesIn(Assembly gameAssembly) =>
        RecordClassesIn(gameAssembly, BindingFlags.Default);

    /// <summary>As <see cref="GrupRecordClassesIn"/>, and every class that inherits its GRUP signature
    /// too: Mutagen reads a deleted OMOD with no data as such a class.</summary>
    internal static IEnumerable<(Type RecordClass, string Table)> RecordClassesIn(Assembly gameAssembly) =>
        RecordClassesIn(gameAssembly, BindingFlags.FlattenHierarchy);

    private static IEnumerable<(Type RecordClass, string Table)> RecordClassesIn(Assembly gameAssembly, BindingFlags inherited)
    {
        foreach (var type in gameAssembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface || !typeof(IMajorRecordGetter).IsAssignableFrom(type)) continue;
            if (GrupSignatureOf(type, inherited) is { } table) yield return (type, table);
        }
    }

    private static string? GrupSignatureOf(Type type, BindingFlags inherited) =>
        type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static | inherited) is { } grup
            ? ((RecordType)(grup.GetValue(null)
                ?? throw new InvalidOperationException($"Expected '{type.Name}.GrupRecordType' to hold a value."))).Type.ToLowerInvariant()
            : null;
}
