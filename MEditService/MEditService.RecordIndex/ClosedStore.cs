using Mutagen.Bethesda;

namespace MEditService.RecordIndex;

/// <summary>The record index file with no store open on it, handed to one call while the Indexer holds it
/// closed. A ref struct, so the call cannot keep it past the moment a reconcile may open the file.</summary>
internal readonly ref struct ClosedStore(StoreFactory factory, long handedOut)
{
    /// <summary>ADR-0010: drops the file and floors its sequence at what this process handed out. The refusal,
    /// or null once the file is rebuilt.</summary>
    public string? Rebuild(GameRelease gameRelease, string instanceRoot) =>
        factory.Rebuild(gameRelease, instanceRoot, handedOut);
}
