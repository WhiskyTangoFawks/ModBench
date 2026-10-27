using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod to build: the source folder holding its manifest, its folder, version and metadata files. Made: the
/// files its build answered it made, once its steps ran. InstallationFiles: those its manifest names, and why the request could not read any, by name.</summary>
public sealed record ModToBuild(
    string Name, string SourceFolder, string Folder, IReadOnlyList<string> MetadataFiles, string? Version, bool IsSubmodule,
    IReadOnlyList<string>? Made = null)
{
    public IReadOnlyList<InstallationFile> InstallationFiles { get; init; } = [];

    public IReadOnlyDictionary<string, string>? UnreadableInstallationFiles { get; init; }
}

/// <summary>The instance's facts a build needs: the exclusion mark, the archive variants, none when the per-release
/// table names none, the stat cache's folder, and each VS Code task this machine has.</summary>
public sealed record InstanceToBuild(string ExclusionMark, ArchiveVariants? Archives, string StatCache)
{
    public IReadOnlySet<string> Tasks { get; init; } = new HashSet<string>();
}

/// <summary>The variant an archive of textures packs as, and the one every other archive packs as.</summary>
public sealed record ArchiveVariants(IArchiveVariant General, IArchiveVariant Textures);

/// <summary>A mod that built. Overwritten: each replaced file that held other bytes (A source mod, story 4). Manifest:
/// the one it records, none after a Failure, written once its Steps ran. Uncommitted and Unpushed: its source's.</summary>
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
