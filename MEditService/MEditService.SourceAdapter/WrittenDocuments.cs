using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>A document mEdit wrote: its absolute path, its text as a read of the file's bytes gives it, and the stamp its
/// file took.</summary>
public sealed record WrittenDocument(string Path, string Text, FileStamp Stamp);

/// <summary>Documents mEdit wrote, each standing in for its file while the file keeps the stamp it took (ADR-0003).</summary>
internal sealed class WrittenDocuments
{
    private readonly Dictionary<string, WrittenDocument> _byPath = new(TreeListing.PathComparer);

    internal WrittenDocuments(IReadOnlyList<WrittenDocument> written)
    {
        foreach (var document in written) _byPath[Path.GetFullPath(document.Path)] = document;
    }

    /// <summary>Null when no document written there still stands.</summary>
    internal string? At(string path) =>
        _byPath.TryGetValue(Path.GetFullPath(path), out var document) && FileStamp.Of(path) == document.Stamp ? document.Text : null;
}
