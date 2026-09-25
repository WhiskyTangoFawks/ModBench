using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>The create gesture: the plugin file, the Track its destination needs before anything
/// can be edited there (ADR-0007 invariant 1), and the plugin's registration in Load order state.
/// Never touches plugins.txt.</summary>
public sealed class CreatePluginHandler
{
    private readonly IPluginAdapter _adapter;
    private readonly TrackService _track;
    private readonly LoadOrderHolder _holder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(IPluginAdapter adapter, TrackService track, LoadOrderHolder holder) =>
        (_adapter, _track, _holder) = (adapter, track, holder);

    /// <summary><paramref name="pluginPath"/> is where the file goes, as Mod Management resolved
    /// it. Throws <see cref="NoLoadOrderException"/> with nothing written when no load order is
    /// held; a write the adapter refuses throws as the adapter does, nothing registered.</summary>
    public async Task<PluginCreateResult> CreatePlugin(string name, string pluginPath, string origin)
    {
        var previous = _holder.Require();
        var plugin = new RegisteredPlugin(name, origin, pluginPath, NextSlot(previous), Enabled: true, Winning: true);

        // A new plugin defaults to an ESL-flagged ESP, silently; the flag is an ordinary editable
        // header field afterward. An explicit .esl is already light, an explicit .esm asked for a
        // full master.
        var modKey = ModKey.FromFileName(plugin.Name);
        await _adapter.CreateAndWriteAsync(
            modKey, plugin.Path, previous.GameRelease, smallMaster: modKey.Type == ModType.Plugin);

        // Applied once the destination is tracked, so the one snapshot change every reader sees
        // names a tracked, readable plugin; a refused Track leaves the load order as it was.
        var track = await TrackDestination(previous.With(plugin), plugin);
        if (track is { Applied: false }) return new PluginCreateResult(plugin, Version: 0, track);

        var version = _holder.Apply(_holder.Current.With(plugin));
        return new PluginCreateResult(plugin, version, track);
    }

    private async Task<TrackResult?> TrackDestination(LoadOrderSnapshot registered, RegisteredPlugin plugin)
    {
        var modFolder = LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path);
        if (modFolder is null) return null;
        if (!SourceRepository.IsTracked(modFolder))
        {
            var track = await _track.TrackAsync(
                registered, [.. registered.PluginsOfOrigin(plugin.Origin).Select(c => c.Key)], SourcePreset.Edits);
            return track.SelectionRefusal
                ?? (track.Refused is [var refused, ..]
                    ? TrackResult.Refused(refused.Refusal, refused.Message)
                    : TrackResult.Success());
        }

        // Modbench's own write is never an external change (ADR-0003 invariant 3): parked as the
        // binary this gesture wrote, so the mod's next settle has nothing to ask about it.
        SourceRepository.ParkCompileSnapshot(modFolder, plugin.Name, atRef: null, PluginBinaryHash.TrailerFormOfFile(plugin.Path));
        return null;
    }

    // One past the highest slot, not the count: a reused slot would give two participants one index.
    private static int NextSlot(LoadOrderSnapshot loadOrder) =>
        loadOrder.Plugins.Count == 0 ? 0 : loadOrder.Plugins.Max(plugin => plugin.Slot ?? 0) + 1;
}
