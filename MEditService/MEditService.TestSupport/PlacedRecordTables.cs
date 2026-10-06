using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.TestSupport;

/// <summary>Every Fallout 4 table whose record Mutagen types as placed in a cell, in the order a pick
/// lists them.</summary>
public static class PlacedRecordTables
{
    public static IReadOnlyList<RecordTableSchema> Fallout4 { get; } =
    [
        .. SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4).Values
            .Where(schema => typeof(IPlacedGetter).IsAssignableFrom(schema.RecordType))
            .OrderBy(schema => schema.DisplayName, StringComparer.OrdinalIgnoreCase),
    ];

    public static IEnumerable<string> Names => Fallout4.Select(schema => schema.TableName);

    public static IEnumerable<string> DisplayNames => Fallout4.Select(schema => schema.DisplayName);
}
