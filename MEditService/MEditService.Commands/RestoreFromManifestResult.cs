using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands;

/// <summary>Landed, skipped or not finished, per mod (ADR-0019), never the status of the call.</summary>
public sealed record RestoreFromManifestResult(IReadOnlyList<ModRestored> Applied, IReadOnlyList<RestoreRefused> Refused)
    : ISelectionAnswer<RestoreRefused>;

/// <summary>A mod whose files are as its manifest says: the files written, each file no line names, why the stat cache
/// did not keep the read, its metadata, what its rebuild left, and each step still to run.</summary>
public sealed record ModRestored(
    string Mod, IReadOnlyList<string> Written, IReadOnlyList<string> NamedByNoLine, string? StatCacheNotWritten, ModMetadata Metadata,
    IReadOnlyList<ManifestStep> Steps, bool Uncommitted = false, string? LeftDetached = null);

/// <summary>A skipped mod. A NotFound mod names the installation files, as its manifest names them, the game files and the submodule
/// it lacks, for a request to fetch and hand. A NotBuilt mod names its build's refusal.</summary>
public sealed record RestoreRefused(
    string Item, RestoreRefusal Refusal, string Message, IReadOnlyList<ManifestPackage.InstallationFile> InstallationFilesNotFound, IReadOnlyList<string> GameFilesNotFound,
    BuildRefusal BuildRefusal = BuildRefusal.None, string? SubmoduleNotFound = null) : IItemRefused<RestoreRefusal>
{
    object IItemRefused<RestoreRefusal>.Item => Item;
}
