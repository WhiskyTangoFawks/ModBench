using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
public sealed record VersionInGitResult(
    IReadOnlyList<VersionedMod> Applied, IReadOnlyList<VersionInGitRefused> Refused)
    : ISelectionAnswer<VersionInGitRefused>;

/// <summary>A mod of the selection that landed whole: every plugin whose source its commit holds. A mod with any
/// plugin refused is refused instead, and writes nothing.</summary>
public sealed record VersionedMod(string Mod, IReadOnlyList<PluginAddress> Plugins);

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming each refused plugin
/// and why.</summary>
public sealed record VersionInGitRefused(string Item, VersionInGitRefusal Refusal, string Message)
    : IItemRefused<VersionInGitRefusal>
{
    object IItemRefused<VersionInGitRefusal>.Item => Item;
}
