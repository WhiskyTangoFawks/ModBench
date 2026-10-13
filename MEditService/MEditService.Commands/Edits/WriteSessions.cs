using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>One session per mod folder over a request's unsaved texts, so an item of a selection sees what the
/// ones before it changed there.</summary>
internal sealed class WriteSessions(ISourceAdapter source, IReadOnlyList<DocumentChange> unsaved)
{
    private readonly Dictionary<string, IWriteSession> _byFolder = new(StringComparer.Ordinal);

    internal IWriteSession Over(PluginProvider.FromMod mod, GameRelease release)
    {
        if (!_byFolder.TryGetValue(mod.Folder, out var session))
            _byFolder[mod.Folder] = session = source.WriteSessionOver(mod, release, unsaved);
        return session;
    }

    /// <summary>Writes the one session that holds changes; a write across folders could not put back a folder it wrote.</summary>
    internal SourceFailure? Write() =>
        _byFolder.Values.Where(Changes).ToList() switch
        {
            [] => null,
            [var changed] => changed.Write(),
            var changed => throw new InvalidOperationException(
                $"Expected a written gesture to change one folder, not {changed.Count}: nothing puts back a folder already written."),
        };

    private static bool Changes(IWriteSession session) =>
        session.Changes is { Moves.Count: > 0 } or { Deletions.Count: > 0 } or { Documents.Count: > 0 };
}
