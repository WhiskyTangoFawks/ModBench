using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands;

/// <summary>Applied or refusal, per mod (ADR-0019), never the status of the call.</summary>
public sealed record BuildResult(IReadOnlyList<ModBuilt> Applied, IReadOnlyList<BuildRefused> Refused)
    : ISelectionAnswer<BuildRefused>;

/// <summary>A mod that built, with what it compiled, refused, replaced, and what stopped it. Steps: each still to run;
/// Made: the files it made, which a request hands back once they ran, for its manifest.</summary>
public sealed record ModBuilt(
    string Mod, IReadOnlyList<CompiledPlugin> Compiled, IReadOnlyList<CompileRefused> Refused,
    IReadOnlyList<ArchiveRefused> ArchivesRefused, IReadOnlyList<string> Overwritten, string? Failure, bool Uncommitted, bool Unpushed,
    IReadOnlyList<ManifestStep> Steps, IReadOnlyList<string> Made);

/// <summary>An archive of a built mod that was not packed, by its path in the mod folder.</summary>
public sealed record ArchiveRefused(string Item, ArchiveRefusal Refusal, string Message) : IItemRefused<ArchiveRefusal>
{
    object IItemRefused<ArchiveRefusal>.Item => Item;
}

/// <summary>A mod of the selection that wrote nothing: the typed refusal, and the message naming the
/// way out. InstallationFilesNotFound and GameFilesNotFound: those its manifest names that the request did not hand, for it to find and hand.</summary>
public sealed record BuildRefused(
    string Item, BuildRefusal Refusal, string Message, IReadOnlyList<ManifestPackage.InstallationFile> InstallationFilesNotFound, IReadOnlyList<string> GameFilesNotFound)
    : IItemRefused<BuildRefusal>
{
    object IItemRefused<BuildRefusal>.Item => Item;
}
