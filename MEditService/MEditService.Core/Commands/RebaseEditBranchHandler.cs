using MEditService.Core.Plugins;
using MEditService.Core.Source;

namespace MEditService.Core.Commands;

/// <summary>The offered rebase (ADR-0046 invariant 3), origin-scoped: the repo, not any one plugin
/// inside it, is the unit of baselines and rebase.</summary>
public sealed class RebaseEditBranchHandler
{
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal RebaseEditBranchHandler(LoadOrderHolder loadOrder) => _loadOrder = loadOrder;

    /// <summary>Null when no registered copy carries the origin: there is no repository to name,
    /// which is an addressing failure rather than one of the three rebase outcomes.</summary>
    public RebaseResult? RebaseEditBranch(string origin) =>
        ModFolders.OfOrigin(_loadOrder.Current, origin) is { } modFolder
            ? SourceRepository.RebaseEditBranch(modFolder)
            : null;
}
