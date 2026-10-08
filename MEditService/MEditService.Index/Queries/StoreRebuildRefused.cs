namespace MEditService.Index.Queries;

/// <summary>Why a store rebuild did nothing (ADR-0010, ADR-0019).</summary>
public enum StoreRebuildRefusal
{
    InstanceRootNotFound,
    HeldByAnotherWindow,
    StillServingReads,
}

public sealed record StoreRebuildRefused(StoreRebuildRefusal Refusal, string Message);
