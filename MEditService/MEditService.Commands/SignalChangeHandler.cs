using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Tells the record index's reader of the files the plugins the changed paths touch, and checks their mods for a
/// change made outside Modbench (ADR-0003). A path read for plugins none can name checks the disk.</summary>
public sealed class SignalChangeHandler
{
    private readonly LoadOrderHolder _holder;
    private readonly ISourceAdapter _source;
    private readonly IPluginAdapter _plugins;
    private readonly ExternalChangeCheck _externalChanges;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal SignalChangeHandler(LoadOrderHolder holder, ISourceAdapter source, IPluginAdapter plugins, ExternalChangeCheck externalChanges) =>
        (_holder, _source, _plugins, _externalChanges) = (holder, source, plugins, externalChanges);

    public void Signal(IReadOnlyList<string> paths)
    {
        if (_holder.Held is not { Snapshot: var snapshot })
        {
            _source.SignalChange(null);
            return;
        }
        if (Touched(snapshot, paths) is not { } touched)
        {
            _source.SignalChange(null);
            _externalChanges.Check(snapshot, snapshot.Plugins);
            return;
        }
        var plugins = touched.Source.Concat(touched.Files).Select(plugin => plugin.Key).Distinct(PluginAddress.Comparer).ToList();
        if (plugins.Count > 0) _source.SignalChange(plugins);
        _externalChanges.Check(snapshot, touched.Files);
    }

    private (List<RegisteredPlugin> Source, List<RegisteredPlugin> Files)? Touched(LoadOrderSnapshot snapshot, IReadOnlyList<string> paths)
    {
        if (paths.Count == 0) return null;
        var (source, files) = (new List<RegisteredPlugin>(), new List<RegisteredPlugin>());
        foreach (var path in paths)
        {
            var (bySource, byFiles) = (_source.Touching(snapshot, path), _plugins.Touching(snapshot, path));
            if (bySource is PathAnswer.Unnamed || byFiles is PathAnswer.Unnamed) return null;
            if (bySource is PathAnswer.Touches sourceTouches) source.AddRange(sourceTouches.Plugins);
            if (byFiles is PathAnswer.Touches filesTouches) files.AddRange(filesTouches.Plugins);
        }
        return (source, files);
    }
}
