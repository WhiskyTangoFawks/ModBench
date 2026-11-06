using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
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

    /// <summary>The changes renaming the plugin makes to plugin source over the unsaved documents mEdit holds, and to
    /// <paramref name="sourceFiles"/>, written nowhere (ADR-0001). Another plugin source follows only when
    /// <paramref name="namedByFileName"/>, or is left behind.</summary>
    public RenameSourceResult RenameSource(PluginAddress plugin, string newName, bool namedByFileName, IReadOnlyList<SourceMove> sourceFiles)
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
                if (!SourceFilesMoved(target, sourceFiles, RepositoryOf).Holds(out var files, out var refusal)) return refusal;
                var (followed, leftBehind) = namedByFileName ? Following(loadOrder, target.Plugin, newName, RepositoryOf) : (SourceChanges.None, []);
                return RenameSourceResult.Landed(
                    new SourceChanges(landed.Moves, landed.Deletions, landed.Documents).Then(files).Then(followed), landed.TreeName, leftBehind);
            },
            RenameSourceResult.Refused);
    }

    // The files of the source folder a build step reads under the plugin's name, which the caller names.
    private Answer<SourceChanges, RenameSourceResult> SourceFilesMoved(
        RenameSourceTarget target, IReadOnlyList<SourceMove> sourceFiles, Func<PluginProvider.FromMod, ISourceRepository> repositoryOf)
    {
        if (sourceFiles.Count == 0 || !_source.IsSourceMod(target.Plugin)) return SourceChanges.None;
        var repository = repositoryOf(target.Mod);
        if (!repository.ChangesToMoveFiles(sourceFiles).Holds(out var moved, out var failure))
            return Refused(RenameSourceRefusal.WriteFailed, $"Could not move {target.Plugin.Name}'s files in its source folder: {failure.Reason}");
        if (moved is null)
        {
            return Refused(RenameSourceRefusal.NameTaken,
                $"{target.Mod.Name}'s source folder already holds one of {string.Join(", ", sourceFiles.Select(file => file.To))}, so {target.Plugin.Name} was not renamed.");
        }
        return moved.Under(repository.SourceFolder);
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
        var (reading, leftBehind) = PluginSources.Naming(_source, loadOrder, renamed.Key);
        leftBehind.RemoveAll(left => PluginAddress.Comparer.Equals(left.Plugin, renamed.Key));
        foreach (var (other, mod) in reading.Where(other => !PluginAddress.Comparer.Equals(other.Plugin.Key, renamed.Key)))
        {
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
