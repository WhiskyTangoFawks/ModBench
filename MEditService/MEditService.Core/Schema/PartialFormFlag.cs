using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

/// <summary>Record-header flag bit 14, "Partial Form": an override that exists only to carry
/// children. Gated on the type being a container record, as xEdit's <c>CanBePartial</c> is; the
/// bit is reused for other meanings.</summary>
public static class PartialFormFlag
{
    /// <summary>Internal so the write-surface guard in Edits can compare the bit without redeclaring it.</summary>
    internal const int Bit = 0x0000_4000;

    /// <summary>The one eligibility gate, shared by the read and write sides.</summary>
    internal static bool IsPartialFormable(Type recordType) =>
        ContainerChildFields.EnumerateChildFieldsFor(recordType) != null;

    public static bool IsSet(IMajorRecordGetter record) =>
        IsPartialFormable(record.GetType()) && (record.MajorRecordFlagsRaw & Bit) != 0;

    /// <summary>Moves exactly bit 14; a whole-value overwrite would drop every other header flag.
    /// Eligibility is the caller's to check.</summary>
    internal static void Set(IMajorRecord record, bool value) =>
        record.MajorRecordFlagsRaw = value
            ? record.MajorRecordFlagsRaw | Bit
            : record.MajorRecordFlagsRaw & ~Bit;
}
