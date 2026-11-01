using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
public sealed record InitSourceModResult(
    IReadOnlyList<InitializedMod> Applied, IReadOnlyList<InitSourceModRefused> Refused)
    : ISelectionAnswer<InitSourceModRefused>;

/// <summary>A mod of the selection that landed whole: every plugin whose source its commit holds. A mod with any
/// plugin refused is refused instead, and writes nothing.</summary>
public sealed record InitializedMod(string Mod, IReadOnlyList<PluginAddress> Plugins);

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming each refused plugin
/// and why.</summary>
public sealed record InitSourceModRefused(string Item, InitSourceModRefusal Refusal, string Message)
    : IItemRefused<InitSourceModRefusal>
{
    object IItemRefused<InitSourceModRefusal>.Item => Item;
}
