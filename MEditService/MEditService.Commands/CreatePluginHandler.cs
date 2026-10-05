using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>The create gesture writes the plugin file and nothing else: no Track, no load order
/// change and no plugins.txt line (create-plugin). The watch hands the new file on.</summary>
public sealed class CreatePluginHandler
{
    private readonly IPluginAdapter _adapter;
    private readonly LoadOrderHolder _holder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(IPluginAdapter adapter, LoadOrderHolder holder) =>
        (_adapter, _holder) = (adapter, holder);

    /// <summary>Throws <see cref="NoLoadOrderException"/> with nothing written when no load order
    /// is held, since the release comes from it.</summary>
    public async Task<PluginCreateResult> CreatePlugin(PluginAddress plugin, string folder)
    {
        var release = _holder.Require().GameRelease;
        var modKey = ModKey.FromFileName(plugin.Name);

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
            EmptyPluginWrite.Written => new PluginCreateResult(),
            EmptyPluginWrite.FolderGone => new PluginCreateResult(PluginCreateRefusal.FolderGone,
                $"The folder {folder} has gone, so {plugin.Name} was not created."),
            EmptyPluginWrite.FileExists => new PluginCreateResult(PluginCreateRefusal.FileExists,
                $"{folder} already holds a file named {plugin.Name}, so it was not created."),
            var outcome => throw new InvalidOperationException($"Unhandled {nameof(EmptyPluginWrite)} outcome: {outcome}."),
        };
    }
}
