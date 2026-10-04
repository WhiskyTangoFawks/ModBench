namespace MEditService.Index;

/// <summary>What asking for a rebuild came to: the refill that follows the drop, and the refusal
/// when another window holds the file (ADR-0010).</summary>
public sealed record StoreRebuild(Task Refill, string? Refusal = null);
