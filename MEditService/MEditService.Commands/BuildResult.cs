using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands;

/// <summary>Applied or refusal, per mod (ADR-0019), never the status of the call.</summary>
public sealed record BuildResult(IReadOnlyList<ModBuilt> Applied, IReadOnlyList<BuildRefused> Refused)
    : ISelectionAnswer<BuildRefused>;

/// <summary>A mod whose step ran: what it compiled and refused, what stopped it, each file it made, which its manifest
/// records (ADR-0016), what it took out of the way for the extension to trash, and each file it left unwritten, ignored.</summary>
public sealed record ModBuilt(
    string Mod, IReadOnlyList<CompiledPlugin> Compiled, IReadOnlyList<CompileRefused> Refused,
    IReadOnlyList<ArchiveRefused> ArchivesRefused, string? Failure, bool Uncommitted, bool Unpushed,
    IReadOnlyList<MadeFile> Made, IReadOnlyList<string> Packed, IReadOnlyList<string> Replaced, IReadOnlyList<string> Ignored);

/// <summary>An archive of a built mod that was not packed, by its path in the mod folder.</summary>
public sealed record ArchiveRefused(string Item, ArchiveRefusal Refusal, string Message) : IItemRefused<ArchiveRefusal>
{
    object IItemRefused<ArchiveRefusal>.Item => Item;
}

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming the way out.</summary>
public sealed record BuildRefused(string Item, BuildRefusal Refusal, string Message) : IItemRefused<BuildRefusal>
{
    object IItemRefused<BuildRefusal>.Item => Item;
}
