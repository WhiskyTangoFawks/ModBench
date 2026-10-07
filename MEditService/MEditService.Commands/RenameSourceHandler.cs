using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands;

/// <summary>Rename source, the first write of renaming a plugin: its source and what Modbench last
/// wrote take the new name, as working-tree changes. The file and its lines are the Instance
/// adapter's.</summary>
public sealed class RenameSourceHandler
{
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal RenameSourceHandler(LoadOrderHolder loadOrder) => _loadOrder = loadOrder;

    /// <summary>Throws <see cref="NoLoadOrderException"/> with nothing written when none is
    /// held.</summary>
    public RenameSourceResult RenameSource(PluginAddress plugin, string newName)
    {
        var loadOrder = _loadOrder.Require();
        try
        {
            SourceRepository.EnsureTrackable();
        }
        catch (GitUnavailableException ex)
        {
            return Refused(RenameSourceRefusal.GitUnavailable, ex.Message);
        }

        if (!ModKey.TryFromFileName(newName, out _))
        {
            return Refused(RenameSourceRefusal.NotAPluginFile, NotAPluginFile.Message(newName, loadOrder.GameRelease));
        }

        if (loadOrder.Plugin(plugin) is not { } loaded)
        {
            return Refused(RenameSourceRefusal.PluginNotLoaded,
                $"{plugin.Name} from '{plugin.Origin}' is not in the load order, so there is no source to rename.");
        }

        if (loaded.Provider is not PluginProvider.FromMod mod
            || !SourceRepository.SourceReads(plugin, mod)
            || SourceRepository.Open(mod, loadOrder.GameRelease) is not { } repository)
        {
            return Refused(RenameSourceRefusal.NotTracked, $"{plugin.Name} has no plugin source, so there is none to rename.");
        }

        try
        {
            return repository.RenameSource(plugin, newName)
                ? new RenameSourceResult()
                : Refused(RenameSourceRefusal.NameTaken,
                    $"{mod.Name} already holds a plugin source named {newName}, so {plugin.Name}'s source was not renamed.");
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return Refused(RenameSourceRefusal.UnreadableSource, $"{plugin.Name}'s source was not renamed: {ex.Message}");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return Refused(RenameSourceRefusal.WriteFailed, $"Could not rename {plugin.Name}'s source: {ex.Message}");
        }
    }

    private static RenameSourceResult Refused(RenameSourceRefusal refusal, string message) => new(refusal, message);
}
