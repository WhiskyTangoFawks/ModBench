using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>What a <c>registrations</c> row carries of the load order (ADR-0013): the
/// plugin's load index, null when the snapshot does not list it as active.</summary>
internal readonly record struct Registration(int? LoadOrderIndex)
{
    internal static Registration In(LoadOrderSnapshot snapshot, PluginAddress address) => new(snapshot.LoadOrderIndex(address));
}
