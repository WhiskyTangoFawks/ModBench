using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The manual, re-runnable rebase, origin-scoped: the repo, not any one plugin
/// inside it, is the unit of baselines and rebase.</summary>
public sealed class RebaseEditBranchHandler
{
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal RebaseEditBranchHandler(LoadOrderHolder loadOrder) => _loadOrder = loadOrder;

    /// <summary>Null when no registered copy carries the origin: there is no repository to name,
    /// which is an addressing failure rather than one of the three rebase outcomes.</summary>
    public RebaseResult? RebaseEditBranch(string origin) =>
        _loadOrder.Current.ModFolderOfOrigin(origin) is { } modFolder
            ? SourceRepository.RebaseEditBranch(modFolder)
            : null;
}
