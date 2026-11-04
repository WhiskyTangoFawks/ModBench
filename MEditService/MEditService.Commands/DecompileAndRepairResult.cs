using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>A plugin to repair, and the source folder made for its mod when the mod is not a source mod.</summary>
public sealed record PluginToRepair(PluginAddress Plugin, SourceFolderContents? SourceFolder = null);

/// <summary>The source folder made for a mod, the repository that holds it, and what the extension hands its first commit
/// (ADR-0016): the assets by path, the build file, and both manifests.</summary>
public sealed record SourceFolderContents(
    string Path, SourceModIn In, IReadOnlyList<string> Assets, byte[] BuildFile, RootFile? Manifest = null, IReadOnlyList<string>? Ignored = null,
    RootFile? ModFolderManifest = null, bool ModFolderManifestInInit = false);

public sealed record DecompileAndRepairResult(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<DecompileAndRepairRefused> Refused)
    : ISelectionAnswer<DecompileAndRepairRefused>;

public sealed record DecompileAndRepairRefused(PluginAddress Item, DecompileAndRepairRefusal Refusal, string Message)
    : IItemRefused<DecompileAndRepairRefusal>
{
    object IItemRefused<DecompileAndRepairRefusal>.Item => Item;
}
