namespace MEditService.LoadOrder;

/// <summary>What a <c>registrations</c> row carries of the load order (ADR-0013 invariant 3): the
/// plugin's load index, null when the snapshot does not list it as active.</summary>
public readonly record struct Registration(int? LoadOrderIndex)
{
    public bool IsActive => LoadOrderIndex is not null;
}
