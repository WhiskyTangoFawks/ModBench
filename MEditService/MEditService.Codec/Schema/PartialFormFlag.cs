using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 14, "Partial Form": an override that exists only to carry
/// children. Gated on the type being a container record because the bit is reused elsewhere;
/// xEdit gates on the record definition declaring it.</summary>
public static class PartialFormFlag
{
    public const int Bit = 0x0000_4000;

    /// <summary>The container-record gate both IsSet overloads read the bit through.</summary>
    public static bool IsPartialFormable(Type recordType) =>
        ContainerChildFields.EnumerateChildFieldsFor(recordType) != null;

    /// <summary>The plugin that alone defines a cell a Partial Form copy can override, or null where any can.</summary>
    public static ModKey? CellsDefinedIn(GameRelease release) =>
        SchemaAnnotations.For(release.ToCategory()).PartialFormCellsDefinedIn is { } plugin ? ModKey.FromFileName(plugin) : (ModKey?)null;

    public static bool IsSet(IMajorRecordGetter record) =>
        IsPartialFormable(record.GetType()) && (record.MajorRecordFlagsRaw & Bit) != 0;

    /// <summary>The same bit read off a stored document, whose header flags travel as
    /// <c>MajorRecordFlagsRaw</c> (omitted when zero).</summary>
    public static bool IsSet(JsonElement document, Type recordType) =>
        IsPartialFormable(recordType)
        && document.TryGetProperty(RecordHeaderFlags.Member, out var flags)
        && flags.ValueKind == JsonValueKind.Number
        && (flags.GetInt32() & Bit) != 0;
}
