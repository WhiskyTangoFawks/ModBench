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

    /// <summary>Holds <paramref name="documents"/> whole, or says why it cannot: without the set the Index would
    /// read the disk, and a document is named by its absolute path.</summary>
    public UnsavedRefused? Apply(IReadOnlyList<DocumentChange>? documents)
    {
        if (documents is null)
            return new UnsavedRefused("The unsaved documents are required, empty when none are dirty.");
        if (documents.Any(document => !Path.IsPathFullyQualified(document.Path)))
            return new UnsavedRefused("Name each document by its absolute path.");

        IReadOnlyList<string> paths;
        lock (_applying)
        {
            paths = [.. Differing(_held, documents).Concat(Differing(documents, _held)).Distinct(StringComparer.Ordinal)];
            Volatile.Write(ref _held, documents);
        }
        if (paths.Count > 0) Arrived?.Invoke(paths);
        return null;
    }

    private static IEnumerable<string> Differing(IReadOnlyList<DocumentChange> from, IReadOnlyList<DocumentChange> against) =>
        from.Where(document => !against.Contains(document)).Select(document => document.Path);
}

public sealed record UnsavedRefused(string Message);
