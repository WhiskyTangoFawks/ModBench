using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>A file of <paramref name="Plugin"/>'s source tree, relative to its mod folder, that its last
/// failed read stopped at: one that is no readable document, or one of the documents that claim
/// <paramref name="FormKey"/>.</summary>
public sealed record SourceFileFailure(PluginAddress Plugin, string SourceRelativePath, string? FormKey, string Message);
