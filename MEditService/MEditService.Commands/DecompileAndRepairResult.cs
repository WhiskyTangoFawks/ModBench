using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Repair;

namespace MEditService.Commands;

/// <summary>Each plugin's preview, or why there is none.</summary>
public sealed record RepairPreviewsResult(IReadOnlyList<PluginRepairPreview> Applied, IReadOnlyList<DecompileAndRepairRefused> Refused)
    : ISelectionAnswer<DecompileAndRepairRefused>;

/// <summary>A malformed plugin's diagnoses, each with the change that repairs it, and the hash of the bytes they came from,
/// which its repair is handed.</summary>
public sealed record PluginRepairPreview(PluginAddress Plugin, string Hash, IReadOnlyList<RepairPreview> Diagnoses);

/// <summary>A plugin to repair as its preview read it, and the source folder its mod's repository is made in when it has
/// none.</summary>
public sealed record PluginToRepair(PluginAddress Plugin, string Hash, string? SourceFolder);

public sealed record DecompileAndRepairResult(IReadOnlyList<PluginAddress> Applied, IReadOnlyList<DecompileAndRepairRefused> Refused)
    : ISelectionAnswer<DecompileAndRepairRefused>;

public sealed record DecompileAndRepairRefused(PluginAddress Item, DecompileAndRepairRefusal Refusal, string Message)
    : IItemRefused<DecompileAndRepairRefusal>
{
    object IItemRefused<DecompileAndRepairRefusal>.Item => Item;
}
