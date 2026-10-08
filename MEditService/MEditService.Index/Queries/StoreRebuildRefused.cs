namespace MEditService.Index.Queries;

/// <summary>Why a store rebuild did nothing (ADR-0010, ADR-0019).</summary>
public enum StoreRebuildRefusal
{
    /// <summary>No instance root, nowhere to keep the store.</summary>
    InstanceRootNotFound,

    /// <summary>Another window holds the instance's index.</summary>
    HeldByAnotherWindow,
}

public sealed record StoreRebuildRefused(StoreRebuildRefusal Refusal, string Message);
