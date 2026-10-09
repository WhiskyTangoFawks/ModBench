using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Rename source, the first write of renaming a plugin: its source takes the new name as changes VS Code
/// applies and saves. What Modbench last wrote follows through <see cref="MoveLastWrittenHandler"/>.</summary>
public sealed class RenameSourceChangesHandler
{
    private readonly LoadOrderHolder _loadOrder;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal RenameSourceChangesHandler(LoadOrderHolder loadOrder) => _loadOrder = loadOrder;

    /// <summary>The changes renaming the plugin's source makes over <paramref name="unsaved"/>, which stand in for
    /// their files, written nowhere (ADR-0001). Throws <see cref="NoLoadOrderException"/> when none is held.</summary>
    public RenameSourceResult RenameSource(PluginAddress plugin, string newName, IReadOnlyList<DocumentChange> unsaved)
    {
        var loadOrder = _loadOrder.Require();
        if (!RenameSourceTarget.Of(loadOrder, plugin, newName, out var target, out var refused)) return refused;
        var (loaded, mod) = target;
        if (!SourceRepository.SourceReads(loaded))
            return RenameSourceTarget.Refused(RenameSourceRefusal.NotTracked, $"{plugin.Name} has no plugin source, so there is none to rename.");

        var batch = SourceBatch.Over(SourceRepository.Over(mod, loadOrder.GameRelease), unsaved);
        if (!batch.Repository.ChangesToRenameSource(plugin, newName).Holds(out var changes, out var failure))
        {
            return failure switch
            {
                SourceFailure.Unreadable => Refused(RenameSourceRefusal.UnreadableSource, $"{plugin.Name}'s source was not renamed: {failure.Reason}"),
                SourceFailure.GitUnavailable => Refused(RenameSourceRefusal.GitUnavailable, failure.Reason),
                _ => Refused(RenameSourceRefusal.WriteFailed, $"Could not rename {plugin.Name}'s source: {failure.Reason}"),
            };
        }
        if (changes is null)
        {
            return Refused(RenameSourceRefusal.NameTaken,
                $"{mod.Name} already holds a plugin source named {newName}, so {plugin.Name}'s source was not renamed.");
        }

        return new RenameSourceResult(Changes: changes.Under(batch.Repository));
    }

    private static RenameSourceResult Refused(RenameSourceRefusal refusal, string message) => RenameSourceTarget.Refused(refusal, message);
}
