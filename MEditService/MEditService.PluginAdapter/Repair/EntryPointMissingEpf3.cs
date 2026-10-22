using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class EntryPointMissingEpf3 : IMalformation
{
    public bool Reads(string recordType, CreationKitShapes shapes) => recordType == "PERK";

    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        var shapes = record.Shapes.EntryPoints;
        return from entry in PerkEntryPoints.Of(record)
               where shapes.FunctionsCarryingEpf3.Contains(entry.Function)
                     && shapes.EpftByFunction.TryGetValue(entry.Function, out var carrying) && entry.Epft == carrying
                     && !entry.HasEpf3
               select new Malformed("entry-point-parameter-shape",
                   $"{entry.Name} is missing EPF3; vanilla always writes it",
                   [new InsertDefault(entry.Epf3At, "EPF3", record.Shapes.SubrecordSizes[("PERK", "EPF3")], 1)]);
    }
}
