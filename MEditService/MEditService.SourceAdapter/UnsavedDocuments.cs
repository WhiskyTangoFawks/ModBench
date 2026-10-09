namespace MEditService.SourceAdapter;

/// <summary>The plugin-source documents VS Code holds unsaved, as Modbench last handed them, whole. Each is read in
/// place of the file at its absolute path (ADR-0015).</summary>
public sealed class UnsavedDocuments
{
    // Replaced wholesale, never mutated, so a reader mid-Apply reads one hand-over whole.
    private IReadOnlyList<DocumentChange> _held = [];
    private readonly Lock _applying = new();

    internal IReadOnlyList<DocumentChange> Current => Volatile.Read(ref _held);

    /// <summary>Raised by every Apply, with the path of each document it handed or dropped.</summary>
    public event Action<IReadOnlyList<string>>? Arrived;

    public void Apply(IReadOnlyList<DocumentChange> documents)
    {
        IReadOnlyList<string> paths;
        lock (_applying)
        {
            paths = [.. _held.Concat(documents).Select(document => document.Path)];
            Volatile.Write(ref _held, documents);
        }
        Arrived?.Invoke(paths);
    }
}
