using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>A plugin mEdit wrote: the files the write names, and the documents written among them. Null files when the
/// write cannot know its result, so the plugin is read back whole (ADR-0029).</summary>
public sealed record HandedPlugin(PluginAddress Plugin, IReadOnlyList<string>? Files, IReadOnlyList<WrittenDocument> Documents)
{
    public static HandedPlugin ReadBack(PluginAddress plugin) => new(plugin, null, []);
}
