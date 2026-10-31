using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>A plugin to repair, and the repository made for its mod when it has none.</summary>
public sealed record PluginToRepair(PluginAddress Plugin, NewRepository? NewRepository = null);

/// <summary>The source folder a mod's repository is made in, and what the extension hands its first commit (ADR-0016): the
/// assets, by their paths in the mod folder, the build file and the manifest.</summary>
public sealed record NewRepository(string SourceFolder, IReadOnlyList<string> Assets, byte[] BuildFile, RootFile? Manifest = null, IReadOnlyList<string>? Ignored = null);

public sealed record DecompileAndRepairResult(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<DecompileAndRepairRefused> Refused)
    : ISelectionAnswer<DecompileAndRepairRefused>;

public sealed record DecompileAndRepairRefused(PluginAddress Item, DecompileAndRepairRefusal Refusal, string Message)
    : IItemRefused<DecompileAndRepairRefusal>
{
    object IItemRefused<DecompileAndRepairRefusal>.Item => Item;
}
