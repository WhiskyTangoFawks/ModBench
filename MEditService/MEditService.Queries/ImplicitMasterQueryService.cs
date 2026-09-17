using MEditService.LoadOrder;

namespace MEditService.Queries;

/// <summary>What ADR-0013 invariant 2 calls "the set of forced names, the game's implicit masters
/// and the Creation Club catalogue", read back from the snapshot that registered them as
/// <see cref="RegisteredCopy.Forced"/> rows.</summary>
public sealed class ImplicitMasterQueryService(LoadOrderHolder loadOrder)
{
    public IReadOnlyList<string> GetImplicitMasters() =>
        [.. loadOrder.Require().Copies.Where(copy => copy.IsForced).Select(copy => copy.Name)];
}
