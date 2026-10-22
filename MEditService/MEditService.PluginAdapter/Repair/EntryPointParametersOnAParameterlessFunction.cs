using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class EntryPointParametersOnAParameterlessFunction : IMalformation
{
    public bool Reads(string recordType, CreationKitShapes shapes) => recordType == "PERK";

    public IEnumerable<Malformed> Detect(InspectedRecord record) =>
        from entry in PerkEntryPoints.Of(record)
        where record.Shapes.EntryPoints.FunctionsWithoutParameters.Contains(entry.Function) && entry.Epft != null
        select new Malformed("entry-point-parameter-shape",
            $"{entry.Name} has EPFT {entry.Epft}; vanilla writes no parameters",
            [new Drop(entry.Parameters)]);
}
