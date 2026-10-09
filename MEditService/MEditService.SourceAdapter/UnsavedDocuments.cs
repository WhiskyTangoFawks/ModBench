namespace MEditService.SourceAdapter;

/// <summary>The plugin-source documents VS Code holds unsaved, as Modbench last handed them, whole. Each is read in
/// place of the file at its absolute path (ADR-0015).</summary>
public sealed class UnsavedDocuments
{
    private IReadOnlyList<DocumentChange> _held = [];
    private readonly Lock _applying = new();

    public IReadOnlyList<DocumentChange> Current => Volatile.Read(ref _held);

    /// <summary>Raised by an Apply that changes the held set, with the path of each document whose text it changed,
    /// handed or dropped.</summary>
    public event Action<IReadOnlyList<string>>? Arrived;

    public void Apply(IReadOnlyList<DocumentChange> documents)
    {
        IReadOnlyList<string> paths;
        lock (_applying)
        {
            paths = [.. Differing(_held, documents).Concat(Differing(documents, _held)).Distinct(StringComparer.Ordinal)];
            Volatile.Write(ref _held, documents);
        }
        if (paths.Count > 0) Arrived?.Invoke(paths);
    }

    private static IEnumerable<string> Differing(IReadOnlyList<DocumentChange> from, IReadOnlyList<DocumentChange> against) =>
        from.Where(document => !against.Contains(document)).Select(document => document.Path);
}
