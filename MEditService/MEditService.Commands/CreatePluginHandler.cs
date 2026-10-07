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
    private readonly PluginDecompiler _decompiler;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(IPluginAdapter adapter, LoadOrderHolder holder, ILogger<CreatePluginHandler> logger) =>
        (_adapter, _holder, _decompiler) = (adapter, holder, new PluginDecompiler(logger, adapter));

    private async Task<PluginCreateResult> LandSourceIfTracked(LoadOrderSnapshot loadOrder, PluginAddress address, string folder)
    {
        var path = Path.Combine(folder, address.Name);
        var plugin = new RegisteredPlugin(address.Name, address.Origin, path, new PluginProvider.FromMod(address.Origin, folder));
        if (!SourceRepository.IsTracked(plugin)) return new PluginCreateResult();

        string failure;
        try
        {
            var decompiled = await _decompiler.DecompileAsync(loadOrder, plugin, folder, onParsed: () => { }, default);
            if (decompiled.Files is { } files)
            {
                SourceRepository.Over((PluginProvider.FromMod)plugin.Provider, loadOrder.GameRelease)
                    .ReplaceSourceFrom(address, files, PluginBinaryHash.TrailerFormOfFile(path));
                return new PluginCreateResult();
            }

            failure = decompiled.Message;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            failure = ex.Message;
        }

        File.Delete(path);
        return new PluginCreateResult(PluginCreateRefusal.WriteFailed,
            $"Could not write {address.Name}'s source into {folder}, so it was not created: {failure}");
    }

    /// <summary>Throws <see cref="NoLoadOrderException"/> with nothing written when no load order
    /// is held, since the release comes from it.</summary>
    public async Task<PluginCreateResult> CreatePlugin(PluginAddress plugin, string folder)
    {
        var loadOrder = _holder.Require();
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

        EmptyPluginWrite written;
        try
        {
            written = await _adapter.CreateAndWriteAsync(modKey, folder, release);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new PluginCreateResult(PluginCreateRefusal.WriteFailed, $"Could not write {plugin.Name} into {folder}: {ex.Message}");
        }

        return written switch
        {
            EmptyPluginWrite.Written => await LandSourceIfTracked(loadOrder, plugin, folder),
            EmptyPluginWrite.FolderGone => new PluginCreateResult(PluginCreateRefusal.FolderGone,
                $"The folder {folder} has gone, so {plugin.Name} was not created."),
            EmptyPluginWrite.FileExists => new PluginCreateResult(PluginCreateRefusal.FileExists,
                $"{folder} already holds a file named {plugin.Name}, so it was not created."),
            var outcome => throw new InvalidOperationException($"Unhandled {nameof(EmptyPluginWrite)} outcome: {outcome}."),
        };
    }
}
