using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod to build, with the source folder whose manifest names its folder, the folder, its version,
/// and its metadata files, which no manifest line names.</summary>
public sealed record ModToBuild(
    string Name, string SourceFolder, string Folder, IReadOnlyList<string> MetadataFiles, string? Version, bool IsSubmodule);

/// <summary>The instance's facts a build needs: the mod manager's exclusion mark, the game's archive
/// variants, none when the per-release table names none, and the stat cache's folder.</summary>
public sealed record InstanceToBuild(string ExclusionMark, ArchiveVariants? Archives, string StatCache);

/// <summary>The variant an archive of textures packs as, and the one every other archive packs as.</summary>
public sealed record ArchiveVariants(IArchiveVariant General, IArchiveVariant Textures);

/// <summary>A mod of the selection that built. Overwritten: each replaced file that held other bytes (A source mod,
/// story 4). Uncommitted and Unpushed as <see cref="SourceToBuild"/>'s. Manifest: the one written, none after a Failure.</summary>
internal sealed record ModBuildOutcome(
    IReadOnlyList<ItemLanded<PluginAddress, IReadOnlyList<CompileDiagnostic>>> Compiled,
    IReadOnlyList<ItemRefused<PluginAddress, CompileRefusal>> Refused,
    IReadOnlyList<ItemRefused<string, ArchiveRefusal>> ArchivesRefused,
    IReadOnlyList<string> Overwritten,
    string? Failure,
    bool Uncommitted = false,
    bool Unpushed = false,
    Manifest? Manifest = null);
