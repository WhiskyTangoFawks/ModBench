using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A file of <paramref name="Plugin"/>'s source tree, relative to its mod folder, that its last
/// failed read stopped at: one that is no readable document, or one of the documents that claim
/// <paramref name="FormKey"/>.</summary>
internal sealed record SourceFileFailure(PluginAddress Plugin, string SourceRelativePath, string? FormKey, string Message)
{
    internal static SourceFileFailure Of(PluginAddress plugin, UnreadableFile file) =>
        new(plugin, file.SourceRelativePath, file.FormKey, file.Message);

    internal static IEnumerable<SourceFileFailure> Of(PluginAddress plugin, ClaimedFormKey claim) =>
        claim.Documents.Select(document => new SourceFileFailure(plugin, document, claim.FormKey, claim.Message));

    /// <summary>The files <paramref name="stoppedBy"/> names, when it names any.</summary>
    internal static IEnumerable<SourceFileFailure> Of(PluginAddress plugin, Exception? stoppedBy) =>
        stoppedBy switch
        {
            UnreadableSourceDocumentException { File: { } file } => [Of(plugin, file)],
            AmbiguousSourceUnitException { Claim: { } claim } => Of(plugin, claim),
            _ => [],
        };
}
