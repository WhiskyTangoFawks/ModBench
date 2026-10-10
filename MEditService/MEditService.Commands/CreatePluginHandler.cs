using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>The create gesture writes the plugin file, and in a tracked mod its source: no Track, no
/// load order change and no plugins.txt line (create-plugin). The watch hands the new file on.</summary>
public sealed class CreatePluginHandler
{
    private readonly IPluginAdapter _adapter;
    private readonly LoadOrderHolder _holder;
    private readonly ISourceAdapter _source;
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(IPluginAdapter adapter, LoadOrderHolder holder, ISourceAdapter source, ILogger<CreatePluginHandler> logger) =>
        (_adapter, _holder, _source, _decompiler) = (adapter, holder, source, new PluginDecompiler(logger, adapter, source));

    private async Task<PluginCreateResult> LandSourceIfTracked(LoadOrderSnapshot loadOrder, PluginAddress address, string folder, string written)
    {
        var modKey = ModKey.FromFileName(address.Name);
        var path = _adapter.PathOfEmpty(modKey, folder);
        var provider = string.Equals(address.Origin, PluginOrigin.Overwrite, StringComparison.OrdinalIgnoreCase)
            ? PluginProvider.NoMod
            : loadOrder.Plugins.FirstOrDefault(p => string.Equals(p.Origin, address.Origin, StringComparison.OrdinalIgnoreCase))?.Provider
                ?? new PluginProvider.FromMod(address.Origin, folder);
        var plugin = new RegisteredPlugin(address.Name, address.Origin, path, provider, Line: null);
        if (!_source.IsTracked(plugin)) return new PluginCreateResult();

        var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, folder, onParsed: () => { }, default);
        var failure = decompiled.Source is { } source
            ? _source.OverFolder((PluginProvider.FromMod)provider, loadOrder.GameRelease)
                .ReplaceSourceFrom(address, source.Files, source.BinarySha256)?.Reason
            : decompiled.Message;
        if (failure is null) return new PluginCreateResult();

        return new PluginCreateResult(PluginCreateRefusal.WriteFailed,
            $"Could not write {address.Name}'s source into {folder}: {failure} {TakeBack(modKey, address.Name, folder, written)}");
    }

    private string TakeBack(ModKey modKey, string name, string folder, string written)
    {
        if (!_adapter.TakeBackEmpty(modKey, folder, written).Holds(out var takenBack, out var failure))
            return $"{name} could not be taken back and is still in {folder}: {failure.Reason}";
        return takenBack switch
        {
            EmptyPluginTakeBack.TakenBack or EmptyPluginTakeBack.Gone => $"{name} was not created.",
            EmptyPluginTakeBack.Changed => $"{name} was changed by something else since it was created, so it was left in {folder}.",
            var outcome => throw new InvalidOperationException($"Unhandled {nameof(EmptyPluginTakeBack)} outcome: {outcome}."),
        };
    }

    /// <summary>Refuses with <see cref="PluginCreateRefusal.NoLoadOrder"/>, writing nothing, when no load order
    /// is held, since the release comes from it.</summary>
    public async Task<PluginCreateResult> CreatePlugin(PluginAddress plugin, string folder)
    {
        if (_holder.Held is not { Snapshot: var loadOrder })
            return new PluginCreateResult(PluginCreateRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);

        var release = loadOrder.GameRelease;
        if (!ModKey.TryFromFileName(plugin.Name, out var modKey))
        {
            return new PluginCreateResult(PluginCreateRefusal.NotAPluginFile, NotAPluginFile.Message(plugin.Name, release));
        }

        if (modKey.Type == ModType.Light && !LightPluginSupport.Of(release))
        {
            return new PluginCreateResult(PluginCreateRefusal.LightPluginUnsupported,
                $"{release} has no light plugins, so {plugin.Name} cannot be created.");
        }

        if (!(await _adapter.CreateAndWriteAsync(modKey, folder, release)).Holds(out var created, out var failure))
            return new PluginCreateResult(PluginCreateRefusal.WriteFailed, $"Could not write {plugin.Name} into {folder}: {failure.Reason}");

        return created.Outcome switch
        {
            EmptyPluginWrite.Written => await LandSourceIfTracked(loadOrder, plugin, folder, created.Written),
            EmptyPluginWrite.FolderGone => new PluginCreateResult(PluginCreateRefusal.FolderGone,
                $"The folder {folder} has gone, so {plugin.Name} was not created."),
            EmptyPluginWrite.FileExists => new PluginCreateResult(PluginCreateRefusal.FileExists,
                $"{folder} already holds a file named {plugin.Name}, so it was not created."),
            var outcome => throw new InvalidOperationException($"Unhandled {nameof(EmptyPluginWrite)} outcome: {outcome}."),
        };
    }
}
