using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.TestSupport;

/// <summary>Every Fallout 4 table whose record Mutagen types as placed in a cell, in the order a pick
/// lists them.</summary>
public static class PlacedRecordTables
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    public static IReadOnlyList<RecordTableSchema> Fallout4 { get; } =
    [
        .. Schemas.Values
            .Where(schema => typeof(IPlacedGetter).IsAssignableFrom(schema.RecordType))
            .OrderBy(schema => Schemas.DisplayNameFor(schema.TableName), StringComparer.OrdinalIgnoreCase),
    ];

    public static IEnumerable<string> Names => Fallout4.Select(schema => schema.TableName);

    public static IEnumerable<string> DisplayNames => Names.Select(Schemas.DisplayNameFor);
}
