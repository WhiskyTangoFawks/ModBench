using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
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

    // Writes the one session that holds changes; a write across folders could not put back a folder it wrote.
    private SourceFailure? Write() =>
        _byFolder.Values.Where(Changes).ToList() switch
        {
            [] => null,
            [var changed] => changed.Write(),
            var changed => throw new InvalidOperationException(
                $"Expected a written gesture to change one folder, not {changed.Count}: nothing puts back a folder already written."),
        };

    /// <summary>The <paramref name="outcome"/> of a gesture whose changes are in these sessions, once they are written and
    /// <paramref name="loadOrder"/> marks it; an outcome that changed nothing is not written.</summary>
    internal RecordEditResult Written(RecordEditResult outcome, string doing, LoadOrderHolder loadOrder, ILogger logger)
    {
        if (!outcome.Applied || !_byFolder.Values.Any(Changes)) return outcome;
        if (Write() is { } failure) return WriteFailure.Refusal(failure, doing, logger);
        loadOrder.SourceWritten();
        return outcome;
    }

    private static bool Changes(IWriteSession session) =>
        session.Changes is { Moves.Count: > 0 } or { Deletions.Count: > 0 } or { Documents.Count: > 0 };
}
