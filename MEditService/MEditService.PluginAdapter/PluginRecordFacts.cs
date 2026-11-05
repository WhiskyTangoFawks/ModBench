using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>What a lookup asks of a plugin about one key, answered for every key by one walk of the
/// mod, so the walk is kept by the file's stamp (ADR-0003) and not repeated for each lookup.</summary>
internal sealed class PluginRecordFacts
{
    internal readonly record struct Fact(string RecordType, string? EditorId, long Flags, Type GetterType);

    private PluginRecordFacts(Dictionary<FormKey, Fact> records, Dictionary<FormKey, DocumentContainment> containments)
    {
        Records = records;
        Containments = containments;
    }

    internal Dictionary<FormKey, Fact> Records { get; }

    // Every child slot names its parent, which is what a compiled plugin reads out of the owner
    // document instead. A block is not a record, so a worldspace's cells are not here.
    internal Dictionary<FormKey, DocumentContainment> Containments { get; }

    internal static PluginRecordFacts Of(IModGetter mod)
    {
        var types = RecordTypes.For(mod.GameRelease);
        var records = new Dictionary<FormKey, Fact>();
        var containments = new Dictionary<FormKey, DocumentContainment>();
        foreach (var record in mod.EnumerateMajorRecords())
        {
            var recordType = types.RecordTypeOf(record);
            records.TryAdd(record.FormKey, new Fact(recordType, record.EditorID, record.MajorRecordFlagsRaw, record.Registration.GetterType));
            foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(record))
                containments.TryAdd(child.FormKey, new DocumentContainment(record.FormKey.ToString(), recordType, slotName));
        }
        return new PluginRecordFacts(records, containments);
    }
}
