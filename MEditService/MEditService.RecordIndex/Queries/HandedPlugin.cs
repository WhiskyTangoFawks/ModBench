using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>A write of a plugin's source, or else of its file: the files it names and the documents written among them.
/// Null files when it cannot know its result, so the plugin is read back whole.</summary>
public sealed record HandedPlugin(PluginAddress Plugin, IReadOnlyList<string>? Files, IReadOnlyList<WrittenDocument> Documents, bool OfSource = true)
{
    public static HandedPlugin ReadBack(PluginAddress plugin) => new(plugin, null, [], OfSource: false);

    public static HandedPlugin ReadBackSource(PluginAddress plugin) => new(plugin, null, []);
}
