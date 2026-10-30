using MEditService.Commands.Build;
using MEditService.Commands.Edits;

namespace MEditService.Commands;

/// <summary>Applied or refusal, per mod (ADR-0019), never the status of the call.</summary>
public sealed record BuildResult(IReadOnlyList<ModBuilt> Applied, IReadOnlyList<BuildRefused> Refused)
    : ISelectionAnswer<BuildRefused>;

/// <summary>A mod that built, with what it compiled, refused, replaced, what stopped it, and each file it made, from which
/// the extension records its manifest (ADR-0016).</summary>
public sealed record ModBuilt(
    string Mod, IReadOnlyList<CompiledPlugin> Compiled, IReadOnlyList<CompileRefused> Refused,
    IReadOnlyList<ArchiveRefused> ArchivesRefused, IReadOnlyList<string> Overwritten, string? Failure, bool Uncommitted, bool Unpushed,
    IReadOnlyList<MadeFile> Made);

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
