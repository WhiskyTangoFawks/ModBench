using MEditService.LoadOrder;

namespace MEditService.Queries;

/// <summary>The plugins the install loads with no list line of their own (ADR-0013 invariant 2), as
/// the held snapshot registered them.</summary>
public sealed class ImplicitMasterQueryService(LoadOrderHolder loadOrder)
{
    public IReadOnlyList<string> GetImplicitMasters() =>
        [.. loadOrder.Require().Copies.Where(copy => copy.IsForced).Select(copy => copy.Name)];
}
