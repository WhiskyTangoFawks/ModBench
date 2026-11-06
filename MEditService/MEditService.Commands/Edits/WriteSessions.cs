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

    /// <summary>What every session's writes change, with absolute paths.</summary>
    internal SourceChanges Made => _byFolder.Values.Aggregate(SourceChanges.None, (all, session) => all.Then(session.Changes));

    // Each folder writes after the ones before it, and a later folder's failure puts back the earlier ones.
    private SourceFailure? Write()
    {
        var changed = _byFolder.Values.Where(Changes).ToList();
        if (changed.Count == 0) return null;
        return changed.SkipLast(1).Reverse().Aggregate<IWriteSession, Func<SourceFailure?>>(changed[^1].Write, (following, session) => () => session.WriteThen(following))();
    }

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
