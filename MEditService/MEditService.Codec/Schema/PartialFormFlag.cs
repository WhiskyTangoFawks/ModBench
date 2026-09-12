using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Schema;

/// <summary>Record-header flag bit 14, "Partial Form": an override that exists only to carry
/// children. Gated on the type being a container record because the bit is reused elsewhere;
/// xEdit gates on the record definition declaring it.</summary>
public static class PartialFormFlag
{
    /// <summary>Internal so the write-surface guard in Edits can compare the bit without redeclaring it.</summary>
    public const int Bit = 0x0000_4000;

    /// <summary>The same bit as the annotation tables spell it.</summary>
    internal static readonly string BitHex = $"0x{Bit:X}";

    /// <summary>The one eligibility gate, shared by the read and write sides.</summary>
    public static bool IsPartialFormable(Type recordType) =>
        ContainerChildFields.EnumerateChildFieldsFor(recordType) != null;

    public static bool IsSet(IMajorRecordGetter record) =>
        IsPartialFormable(record.GetType()) && (record.MajorRecordFlagsRaw & Bit) != 0;

    /// <summary>The same bit read off a stored document, whose header flags travel as
    /// <c>MajorRecordFlagsRaw</c> (omitted when zero).</summary>
    public static bool IsSet(JsonElement document, Type recordType) =>
        IsPartialFormable(recordType)
        && document.TryGetProperty(nameof(IMajorRecordGetter.MajorRecordFlagsRaw), out var flags)
        && flags.ValueKind == JsonValueKind.Number
        && (flags.GetInt32() & Bit) != 0;
}
