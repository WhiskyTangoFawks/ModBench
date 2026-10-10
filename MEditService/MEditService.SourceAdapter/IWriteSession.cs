using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>Writes to one mod folder's plugin source, answered as the changes they make, written nowhere
/// (ADR-0001).</summary>
public interface IWriteSession
{
    /// <summary>The repository the session's writes are made through, reading the held unsaved texts in place of
    /// their files, and each change made through the session. Its verbs that write the disk themselves refuse.</summary>
    ISourceRepository Repository { get; }

    /// <summary>What the session's writes change, with absolute paths. Applied as moves, then deletions, then
    /// documents, it leaves the tree as the writes would have one after another.</summary>
    SourceChanges Changes { get; }

    /// <summary>What the writes since <paramref name="before"/>, a snapshot of <see cref="Changes"/>, added to it.</summary>
    SourceChanges ChangesAddedSince(SourceChanges before);

    /// <summary>Runs <paramref name="write"/>, which applies changes to this session. Changes that failed put back
    /// what it applied, and the answer is why (commands.md, A failed gesture writes nothing).</summary>
    SourceFailure? Atomically(Action write);

    /// <summary><see cref="Atomically(Action)"/>, answering what <paramref name="write"/> answers. A failure it answers
    /// puts back what it applied too.</summary>
    Answer<T, SourceFailure> Atomically<T>(Func<Answer<T, SourceFailure>> write);

    /// <summary>Makes each move of <paramref name="changes"/>, then each deletion, then writes each document, over those
    /// made so far. Changes that failed stop the write applying them, and nothing after them applies.</summary>
    void Apply(Answer<SourceChanges, SourceFailure> changes);
}
