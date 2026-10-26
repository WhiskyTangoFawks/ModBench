using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod to build, with the source folder whose manifest names its folder, the folder, its version,
/// and its metadata files, which no manifest line names. Made: each file its build made, as the build answered with its
/// steps, which have run since, so the build writes its manifest and nothing else.</summary>
public sealed record ModToBuild(
    string Name, string SourceFolder, string Folder, IReadOnlyList<string> MetadataFiles, string? Version, bool IsSubmodule,
    IReadOnlyList<string>? Made = null);

/// <summary>The instance's facts a build needs: the mod manager's exclusion mark, the game's archive
/// variants, none when the per-release table names none, the stat cache's folder, and the label of each VS Code task
/// this machine has.</summary>
public sealed record InstanceToBuild(string ExclusionMark, ArchiveVariants? Archives, string StatCache)
{
    public IReadOnlySet<string> Tasks { get; init; } = new HashSet<string>();
}

/// <summary>The variant an archive of textures packs as, and the one every other archive packs as.</summary>
public sealed record ArchiveVariants(IArchiveVariant General, IArchiveVariant Textures);

/// <summary>A mod of the selection that built. Overwritten: each replaced file that held other bytes (A source mod,
/// story 4). Uncommitted and Unpushed as <see cref="SourceToBuild"/>'s. Manifest: the one its build records, none after a Failure.
/// Steps: the steps still to run, after which the build writes that manifest.</summary>
internal sealed record ModBuildOutcome(
    IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Compiled,
    IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused,
    IReadOnlyList<ItemRefused<string, ArchiveRefusal>> ArchivesRefused,
    IReadOnlyList<string> Overwritten,
    string? Failure,
    bool Uncommitted = false,
    bool Unpushed = false,
    Manifest? Manifest = null)
{
    public IReadOnlyList<ManifestStep> Steps { get; init; } = [];
}
