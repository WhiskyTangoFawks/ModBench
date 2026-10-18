using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Applied or refusal, per plugin (ADR-0019), never the status of the call.</summary>
public sealed record DecompileResponse(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<PluginDecompileRefusal> Refused)
    : ISelectionAnswer<PluginDecompileRefusal>;

/// <summary>A plugin of the selection that wrote nothing, with the typed refusal and the message naming
/// the way out.</summary>
public sealed record PluginDecompileRefusal(PluginAddress Item, DecompileRefusal Refusal, string Message) : IItemRefused
{
    object IItemRefused.Item => Item;

    object IItemRefused.Refusal => Refusal;
}
