using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>What one read of a plugin reads from (ADR-0003): the binary's hash, and for a plugin with a
/// tree, each document's content stamp, or the doubly claimed FormKey the tree named instead.</summary>
internal sealed record ReadState(string? Binary, RecordStamps? Stamps, string? Ambiguity)
{
    /// <summary>Whether a failed read stands while this holds. A binary or document that could not be
    /// read is no evidence either way.</summary>
    public bool Vouches => Stamps is { } stamps ? stamps.Unreadable.Count == 0 : Ambiguity is not null || Binary is not null;
}
