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
        if (SourceRepository.WhyGitCannotRun() is { } gitMissing) return Refused(RenameSourceRefusal.GitUnavailable, gitMissing.Reason);

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
            || !SourceRepository.SourceReads(loaded))
        {
            return Refused(RenameSourceRefusal.NotTracked, $"{plugin.Name} has no plugin source, so there is none to rename.");
        }

        var repository = SourceRepository.Over(mod, loadOrder.GameRelease);
        if (!repository.RenameSource(plugin, newName).Holds(out var renamed, out var failure))
        {
            return failure switch
            {
                SourceFailure.Unreadable => Refused(RenameSourceRefusal.UnreadableSource, $"{plugin.Name}'s source was not renamed: {failure.Reason}"),
                SourceFailure.GitUnavailable => Refused(RenameSourceRefusal.GitUnavailable, failure.Reason),
                _ => Refused(RenameSourceRefusal.WriteFailed, $"Could not rename {plugin.Name}'s source: {failure.Reason}"),
            };
        }
        return renamed
            ? new RenameSourceResult()
            : Refused(RenameSourceRefusal.NameTaken,
                $"{mod.Name} already holds a plugin source named {newName}, so {plugin.Name}'s source was not renamed.");
    }

    private static RenameSourceResult Refused(RenameSourceRefusal refusal, string message) => new(refusal, message);
}
