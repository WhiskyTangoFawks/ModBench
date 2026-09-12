using MEditService.Core.Plugins;
using MEditService.Core.Source;

namespace MEditService.Core.Commands;

/// <summary>Resuming the rebase a <c>Conflicted</c> outcome left mid-flight (ADR-0014 invariant 3).
/// Origin-scoped, like the rebase it continues.</summary>
public sealed class ContinueRebaseEditBranchHandler
{
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal ContinueRebaseEditBranchHandler(LoadOrderHolder loadOrder) => _loadOrder = loadOrder;

    /// <summary>Null when no registered copy carries the origin: there is no repository to name,
    /// which is an addressing failure rather than one of the three rebase outcomes.</summary>
    public RebaseResult? ContinueRebase(string origin) =>
        _loadOrder.Current.ModFolderOfOrigin(origin) is { } modFolder
            ? SourceRepository.ContinueRebase(modFolder)
            : null;
}
