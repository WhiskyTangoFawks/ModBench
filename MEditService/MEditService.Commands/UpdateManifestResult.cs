using MEditService.Commands.Build;
using MEditService.Commands.Edits;

namespace MEditService.Commands;

/// <summary>Landed or refused, per mod (ADR-0019), never the status of the call.</summary>
public sealed record UpdateManifestResult(IReadOnlyList<ModUpdated> Applied, IReadOnlyList<UpdateManifestRefused> Refused)
    : ISelectionAnswer<UpdateManifestRefused>;

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NotInPackage names each file its package does not hold, and OtherBytes each file it holds with other bytes. StatCacheNotWritten is why the stat cache failed, or null.</summary>
public sealed record ModUpdated(string Mod, bool ManifestWritten, IReadOnlyList<string> NotInPackage, IReadOnlyList<string> OtherBytes, string? StatCacheNotWritten);

/// <summary>A mod whose manifest was left as it was: the typed refusal, and the message naming the way out.</summary>
public sealed record UpdateManifestRefused(string Item, UpdateManifestRefusal Refusal, string Message) : IItemRefused<UpdateManifestRefusal>
{
    object IItemRefused<UpdateManifestRefusal>.Item => Item;
}
