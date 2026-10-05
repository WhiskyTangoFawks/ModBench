using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

namespace MEditService.Codec.Serialization;

/// <summary>A deleted record holding no fields as its header alone, which is what a mutable read makes
/// of it; Mutagen's overlay throws reading some absent fields instead.</summary>
internal static class DeletedRecord
{
    /// <summary>The record's document, or its header's where it is deleted, its file gives it no field and
    /// the overlay cannot serialize it. Any other failure is the caller's to diagnose.</summary>
    internal static byte[] Serialize(
        RecordTextCodec codec, IMajorRecordGetter record, RecordTableSchema schema, GameRelease release, IRecordFieldProbe file)
    {
        try
        {
            return codec.SerializeToBytes(record, release);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException
            && (record.MajorRecordFlagsRaw & DeletedFlag.Bit) != 0
            && file.HoldsNoFields(record.FormKey)
            && HeaderOf(record, schema, release) is { } header)
        {
            return codec.SerializeToBytes(header, release);
        }
    }

    // A container is left to fail: a header alone would drop its children.
    private static IMajorRecord? HeaderOf(IMajorRecordGetter record, RecordTableSchema schema, GameRelease release)
    {
        if (ContainerChildFields.EnumerateChildFieldsFor(schema.RecordType) != null) return null;
        if (ReflectedTypes.GetSetterType(schema.RecordType) is not { } recordClass) return null;

        var header = MajorRecordInstantiator.Activator(record.FormKey, release, recordClass);
        header.EditorID = record.EditorID;
        var getters = ReflectedTypes.GetAllInterfaceProperties(schema.RecordType).ToLookup(p => p.Name, StringComparer.Ordinal);
        foreach (var member in schema.RecordColumns.Where(c => c.Field.IsRecordHeaderMember).Select(c => c.PropertyName))
        {
            var setter = recordClass.GetProperty(member);
            if (setter is not { CanWrite: true } || getters[member].FirstOrDefault() is not { } getter) continue;
            setter.SetValue(header, getter.GetValue(record));
        }
        return header;
    }
}
