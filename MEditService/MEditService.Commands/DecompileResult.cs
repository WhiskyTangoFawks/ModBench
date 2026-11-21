using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

public sealed record DecompileResult(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<DecompileRefused> Refused, IReadOnlyList<string> Written)
    : ISelectionAnswer<DecompileRefused>;

public sealed record DecompileRefused(PluginAddress Item, DecompileRefusal Refusal, string Message) : IItemRefused<DecompileRefusal>
{
    object IItemRefused<DecompileRefusal>.Item => Item;
}
