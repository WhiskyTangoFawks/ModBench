using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Rename source, the first write of renaming a plugin: its source takes the new name, and every other plugin
/// source follows it, as changes VS Code applies and saves. What Modbench last wrote follows through
/// <see cref="MoveLastWrittenHandler"/>.</summary>
public sealed class RenameSourceChangesHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly ISourceAdapter _source;
    private readonly UnsavedDocuments _unsaved;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal RenameSourceChangesHandler(LoadOrderHolder loadOrder, ISourceAdapter source, UnsavedDocuments unsaved) =>
        (_loadOrder, _source, _unsaved) = (loadOrder, source, unsaved);

    /// <summary>The changes renaming the plugin makes to plugin source over the unsaved documents mEdit holds, which stand
    /// in for their files, written nowhere (ADR-0001). A plugin source that cannot follow is left behind, saying why.</summary>
    public RenameSourceResult RenameSource(PluginAddress plugin, string newName)
    {
        if (_loadOrder.Held is not { Snapshot: var loadOrder })
            return RenameSourceResult.Refused(RenameSourceRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        if (!RenameSourceTarget.Of(_source, loadOrder, plugin, newName, out var target, out var refused))
            return RenameSourceResult.Refused(refused.Value.Refusal, refused.Value.Message);

        var sessions = new Dictionary<string, ISourceRepository>(StringComparer.OrdinalIgnoreCase);
        ISourceRepository RepositoryOf(PluginProvider.FromMod mod)
        {
            if (!sessions.TryGetValue(mod.Name, out var repository))
            {
                repository = _source.WriteSessionOver(mod, loadOrder.GameRelease, _unsaved.Current).Repository;
                sessions[mod.Name] = repository;
            }
            return repository;
        }

        return OwnSource(target, plugin, newName, RepositoryOf).Match(
            landed =>
            {
                var (followed, leftBehind) = Following(loadOrder, target.Plugin, newName, RepositoryOf);
                return RenameSourceResult.Landed(
                    new SourceChanges(landed.Moves, landed.Deletions, landed.Documents).Then(followed), landed.TreeName, leftBehind);
            },
            RenameSourceResult.Refused);
    }

    private RenameSourceResult OwnSource(
        RenameSourceTarget target, PluginAddress plugin, string newName, Func<PluginProvider.FromMod, ISourceRepository> repositoryOf)
    {
        var (loaded, mod) = target;
        if (!_source.SourceReads(loaded))
        {
            return _source.WhySourceDoesNotRead(loaded) is { } why and not SourceFailure.NotCarried
                ? Unreadable(plugin, why)
                : RenameSourceResult.Landed(SourceChanges.None, plugin.Name, []);
        }

        var repository = repositoryOf(mod);
        if (!repository.ChangesToRenameSource(plugin, newName).Holds(out var changes, out var failure))
        {
            return failure switch
            {
                SourceFailure.Unreadable => Unreadable(plugin, failure),
                SourceFailure.GitUnavailable => Refused(RenameSourceRefusal.GitUnavailable, failure.Reason),
                _ => Refused(RenameSourceRefusal.WriteFailed, $"Could not rename {plugin.Name}'s source: {failure.Reason}"),
            };
        }
        if (changes is null)
        {
            return Refused(RenameSourceRefusal.NameTaken,
                $"{mod.Name} already holds a plugin source named {newName}, so {plugin.Name}'s source was not renamed.");
        }

        return RenameSourceResult.Landed(changes.Under(repository.SourceFolder), repository.TreeNameOf(plugin), []);
    }

    // Each other plugin source with the renamed plugin's FormKeys under the new name.
    private (SourceChanges Followed, IReadOnlyList<SourceLeftBehind> LeftBehind) Following(
        LoadOrderSnapshot loadOrder, RegisteredPlugin renamed, string newName, Func<PluginProvider.FromMod, ISourceRepository> repositoryOf)
    {
        var followed = SourceChanges.None;
        var leftBehind = new List<SourceLeftBehind>();
        foreach (var other in loadOrder.Plugins.Where(other => other.Key != renamed.Key && _source.IsSourceMod(other)))
        {
            if (other.Provider is not PluginProvider.FromMod mod) continue;
            if (!_source.SourceReads(other))
            {
                if (_source.WhySourceDoesNotRead(other) is { } why and not SourceFailure.NotCarried) leftBehind.Add(new(other.Key, why.Reason));
                continue;
            }
            var repository = repositoryOf(mod);
            if (repository.ChangesToFollowRename(other.Key, renamed.Name, newName).Holds(out var changes, out var failure))
                followed = followed.Then(changes.Under(repository.SourceFolder));
            else
                leftBehind.Add(new(other.Key, failure.Reason));
        }
        return (followed, leftBehind);
    }

    private static RenameSourceResult Refused(RenameSourceRefusal refusal, string message) => RenameSourceResult.Refused(refusal, message);

    private static RenameSourceResult Unreadable(PluginAddress plugin, SourceFailure why) =>
        Refused(RenameSourceRefusal.UnreadableSource, $"{plugin.Name}'s source was not renamed: {why.Reason}");
}
