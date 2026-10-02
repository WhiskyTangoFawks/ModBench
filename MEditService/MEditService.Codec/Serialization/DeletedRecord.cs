using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;

namespace MEditService.Codec.Serialization;

/// <summary>A deleted record as its header alone, which is what a mutable read makes of one whose
/// fields are absent; Mutagen's overlay throws reading some absent fields instead.</summary>
internal static class DeletedRecord
{
    /// <summary>Null for a record that is not deleted, or whose children a header alone would drop.</summary>
    internal static IMajorRecord? HeaderOf(IMajorRecordGetter record, RecordTableSchema schema, GameRelease release)
    {
        if ((record.MajorRecordFlagsRaw & DeletedFlag.Bit) == 0) return null;
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
