using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Repair;
using MEditService.RepositoriesLib;

namespace MEditService.Commands;

/// <summary>Each plugin's preview, or why there is none.</summary>
public sealed record RepairPreviewsResult(IReadOnlyList<PluginRepairPreview> Applied, IReadOnlyList<DecompileAndRepairRefused> Refused)
    : ISelectionAnswer<DecompileAndRepairRefused>;

/// <summary>A malformed plugin's diagnoses, each with the change that repairs it, and the hash of the bytes they came from,
/// which its repair is handed.</summary>
public sealed record PluginRepairPreview(PluginAddress Plugin, string Hash, IReadOnlyList<RepairPreview> Diagnoses);

/// <summary>A plugin to repair as its preview read it, and the repository made for its mod when it has none.</summary>
public sealed record PluginToRepair(PluginAddress Plugin, string Hash, NewRepository? NewRepository = null);

/// <summary>The source folder a mod's repository is made in, and what the extension hands its first commit (ADR-0016): the
/// assets, by their paths in the mod folder, and the manifest.</summary>
public sealed record NewRepository(string SourceFolder, IReadOnlyList<string> Assets, SpelledManifest Manifest);

public sealed record DecompileAndRepairResult(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<DecompileAndRepairRefused> Refused)
    : ISelectionAnswer<DecompileAndRepairRefused>;

public sealed record DecompileAndRepairRefused(PluginAddress Item, DecompileAndRepairRefusal Refusal, string Message)
    : IItemRefused<DecompileAndRepairRefusal>
{
    object IItemRefused<DecompileAndRepairRefusal>.Item => Item;
}
