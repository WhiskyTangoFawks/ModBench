using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
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
        .. typeof(IPlacedGetter).Assembly.GetTypes()
            .Where(type => type is { IsClass: true, IsAbstract: false, IsPublic: true } && typeof(IPlacedGetter).IsAssignableFrom(type))
            .Select(type => RecordTypes.For(GameRelease.Fallout4).RecordTypeNamed(type.Name))
            .OfType<string>()
            .Distinct()
            .Select(table => Schemas[table])
            .OrderBy(schema => Schemas.DisplayNameFor(schema.TableName), StringComparer.OrdinalIgnoreCase),
    ];

    public static IEnumerable<string> Names => Fallout4.Select(schema => schema.TableName);

    public static IEnumerable<string> DisplayNames => Names.Select(Schemas.DisplayNameFor);
}
