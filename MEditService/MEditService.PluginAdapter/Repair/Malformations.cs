using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Binary.Headers;

namespace MEditService.PluginAdapter.Repair;

/// <summary>Every malformation class of this assembly (ADR-0006), each read from the plugin's original
/// subrecords, free of Mutagen's typed parse. Expected values come from vanilla binaries, not a
/// reference's comments.</summary>
internal static class Malformations
{
    private static readonly IReadOnlyList<IMalformation> All =
    [
        .. typeof(IMalformation).Assembly.GetTypes()
            .Where(type => type is { IsClass: true, IsAbstract: false } && type.IsAssignableTo(typeof(IMalformation)))
            .OrderBy(type => type.Name, StringComparer.Ordinal)
            .Select(Activator.CreateInstance)
            .OfType<IMalformation>(),
    ];

    /// <summary>A malformation found in one record of a plugin.</summary>
    internal sealed record Found(MajorRecordPinFrame Record, IReadOnlyList<Subrecord> Subrecords, PluginDiagnosis Diagnosis, IReadOnlyList<SubrecordEdit>? Repair)
    {
        internal RepairPreview Preview => new(Diagnosis, Repair is null
            ? null
            : new RepairChange(string.Join("; ", Repair.Select(edit => edit.Describe(Subrecords))), DroppedBytes(Repair, Subrecords)));
    }

    /// <summary>Every malformation the plugin's own bytes prove, in record order.</summary>
    internal static List<Found> In(byte[] pluginBytes, GameRelease gameRelease)
    {
        var shapes = GameCodecs.For(gameRelease).CreationKitShapes;
        var readersByType = new Dictionary<string, IMalformation[]>();
        var found = new List<Found>();
        foreach (var record in PluginBinaryWalk.Records(pluginBytes, gameRelease))
        {
            var type = record.RecordType.Type;
            if (!readersByType.TryGetValue(type, out var readers))
                readersByType[type] = readers = [.. All.Where(m => m.Reads(type, shapes))];
            if (readers.Length == 0 || PluginBinaryWalk.Subrecords(record) is not { } frames) continue;

            var subrecords = frames.Select(Subrecord.Of).ToList();
            var inspected = new InspectedRecord(type, subrecords, shapes);
            var anchor = Anchor(type, record.FormID.Raw, subrecords);
            // One diagnosis for equal ones in one record, so a choice of it repairs each.
            foreach (var equal in readers.SelectMany(m => m.Detect(inspected)).GroupBy(m => (m.DefectClass, m.Message)))
            {
                IReadOnlyList<SubrecordEdit>? repair = equal.All(m => m.Repair is not null) ? [.. equal.SelectMany(m => m.Repair ?? [])] : null;
                var diagnosis = new PluginDiagnosis(anchor, equal.Key.DefectClass, Tail(repair, subrecords), equal.Key.Message);
                found.Add(new Found(record, subrecords, diagnosis, repair));
            }
        }
        return found;
    }

    private static string? Tail(IReadOnlyList<SubrecordEdit>? repair, IReadOnlyList<Subrecord> subrecords)
    {
        if (repair is null) return null;
        var dropped = DroppedBytes(repair, subrecords);
        return dropped > 0 ? $"repairable (drops {dropped} bytes)" : "repairable (lossless)";
    }

    private static int DroppedBytes(IReadOnlyList<SubrecordEdit> repair, IReadOnlyList<Subrecord> subrecords) =>
        repair.Sum(edit => edit.DroppedBytes(subrecords));

    private static string Anchor(string recordType, uint formId, List<Subrecord> subrecords)
    {
        var edid = subrecords.FindIndex(s => s.Signature == "EDID");
        var name = edid >= 0 && subrecords[edid].Payload.Length > 0
            ? Encoding.UTF8.GetString(subrecords[edid].Payload.Span).TrimEnd('\0')
            : null;
        return $"{recordType} {formId:X8}{(name != null ? $" ({name})" : "")}";
    }
}
