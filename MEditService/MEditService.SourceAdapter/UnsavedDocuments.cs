namespace MEditService.SourceAdapter;

/// <summary>The plugin-source documents VS Code holds unsaved, each as Modbench last handed it, whole. Each is read in
/// place of the file at its absolute path.</summary>
public sealed class UnsavedDocuments
{
    private readonly Dictionary<string, (DocumentChange Document, long Version)> _held = new(StringComparer.Ordinal);
    private readonly Lock _applying = new();

    public IReadOnlyList<DocumentChange> Current
    {
        get
        {
            lock (_applying) return [.. _held.Values.Select(held => held.Document)];
        }
    }

    /// <summary>Holds <paramref name="document"/>, or says why it cannot. An open replaces what is held, and a change
    /// older than the version held is ignored. <paramref name="changed"/> is false when the text held is the text.</summary>
    public UnsavedRefused? Hold(DocumentChange document, long version, bool opened, out bool changed)
    {
        changed = false;
        if (NotAbsolute(document.Path) is { } refused) return refused;
        lock (_applying)
        {
            var held = _held.TryGetValue(document.Path, out var standing);
            if (held && !opened && version < standing.Version) return null;
            changed = !held || standing.Document != document;
            _held[document.Path] = (document, version);
        }
        return null;
    }

    /// <summary>Drops the document at <paramref name="path"/>, so its file is read again. <paramref name="changed"/> is
    /// false when none is held.</summary>
    public UnsavedRefused? Drop(string path, out bool changed)
    {
        changed = false;
        if (NotAbsolute(path) is { } refused) return refused;
        lock (_applying) changed = _held.Remove(path);
        return null;
    }

    // A document is named by its absolute path, or the index would read the disk.
    private static UnsavedRefused? NotAbsolute(string path) =>
        Path.IsPathFullyQualified(path) ? null : new UnsavedRefused("Name each document by its absolute path.");
}

public sealed record UnsavedRefused(string Message);
