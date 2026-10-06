using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>What one read of a plugin reads from (ADR-0003): the binary's hash, and for a plugin with a
/// tree, each document's content stamp.</summary>
internal sealed record ReadState(string? Binary, RecordStamps? Stamps)
{
    /// <summary>Whether a failed read stands while this holds. A binary or document that could not be
    /// read is no evidence either way.</summary>
    public bool Vouches => Stamps is { } stamps ? stamps.Unreadable.Count == 0 : Binary is not null;

    /// <summary>The files of the tree that fail any read of it.</summary>
    public IEnumerable<SourceFileFailure> FileFailuresOf(PluginAddress plugin) =>
        Stamps is not { } stamps
            ? []
            : stamps.Unreadable.Select(file => new SourceFileFailure(plugin, file.SourceRelativePath, null, file.Message))
                .Concat(stamps.Claimed.SelectMany(claim => claim.Documents.Select(document =>
                    new SourceFileFailure(plugin, document, claim.FormKey, claim.Message))));
}
