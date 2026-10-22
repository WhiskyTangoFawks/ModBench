using MEditService.Codec.Serialization;

namespace MEditService.PluginAdapter.Repair;

internal sealed class EntryPointParameterOfAnotherType : IMalformation
{
    public bool Reads(string recordType, CreationKitShapes shapes) => recordType == "PERK";

    // No repair: converting the parameter's value between EPFT encodings, an actor value index to an
    // AVIF FormKey, is a semantic mapping, not one of the engine's byte operations.
    public IEnumerable<Malformed> Detect(InspectedRecord record)
    {
        foreach (var entry in PerkEntryPoints.Of(record))
        {
            if (record.Shapes.EntryPoints.EpftByFunction.TryGetValue(entry.Function, out var expected) && entry.Epft is { } epft && epft != expected)
                yield return new Malformed("entry-point-parameter-shape", $"{entry.Name} has EPFT {epft}; vanilla writes EPFT {expected}", Repair: null);
        }
    }
}
