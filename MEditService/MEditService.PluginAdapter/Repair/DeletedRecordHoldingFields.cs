using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class DeletedRecordHoldingFields : IMalformation
{
    internal const string DefectClass = "deleted-record-holds-fields";

    private const string BaseRecord = "NAME";

    public bool Reads(string recordType, CreationKitShapes shapes) => true;

    public bool ReadsOnlyDeleted => true;

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        // Mutagen's WriteWorldspacesParallel skips WriteMajorRecord's deleted return, so a deleted worldspace keeps its fields.
        if (record.Types.IsWorldspace(record.Type)) yield break;

        var isReference = record.Types.IsReference(record.Type);
        var held = record.Subrecords.Where(sub => !(isReference && sub.Signature == BaseRecord)).ToList();
        if (held.Count == 0) yield break;

        yield return new Malformed(DefectClass,
            $"flagged Deleted and holds {string.Join(", ", held.Select(sub => sub.Signature))}; Mutagen writes a deleted record as its header alone",
            [new Drop([.. Enumerable.Range(0, record.Subrecords.Count)])]);
    }
}
