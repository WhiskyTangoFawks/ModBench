using System.Text;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>Documents mEdit wrote, each standing in for its file while the file keeps the stamp it took (ADR-0003).</summary>
internal sealed class WrittenDocuments
{
    private readonly Dictionary<string, WrittenDocument> _byPath = new(TreeListing.PathComparer);

    internal WrittenDocuments(IReadOnlyList<WrittenDocument> written)
    {
        foreach (var document in written) _byPath[Path.GetFullPath(document.Path)] = document;
    }

    /// <summary>The text a read of the file's bytes gives; null when no document written there still stands.</summary>
    internal string? At(string path)
    {
        if (!_byPath.TryGetValue(Path.GetFullPath(path), out var document) || WrittenStamp.Of(path) != document.Stamp) return null;
        return Encoding.UTF8.GetString(DocumentText.StripUtf8Bom(Encoding.UTF8.GetBytes(document.Text)));
    }
}
