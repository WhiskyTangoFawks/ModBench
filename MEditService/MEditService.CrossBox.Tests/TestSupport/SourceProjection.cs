using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceRepo;

namespace MEditService.Tests.TestSupport;

/// <summary>A working-tree change made the Source repository's own way, then the narrow signal the
/// Source watcher sends for it (ADR-0015 invariant 2).</summary>
internal static class SourceProjection
{
    internal static void ProjectDocuments(
        this IndexProjector index, LoadOrderHolder holder, PluginCopyKey key,
        IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        var modFolder = SourceRepository.TrackedModFolderOf(holder.Current, key)
            ?? throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not a tracked copy.");
        var repository = SourceRepository.Over(modFolder, holder.Current.GameRelease);
        var reads = index.RequireReads();
        foreach (var (formKey, body) in deltas)
        {
            var current = reads.GetDocument(formKey, key)
                ?? throw new InvalidOperationException($"{key.Name} holds no document for '{formKey}' to change.");
            if (body is null)
                repository.Remove(key, new RecordIdentity(formKey, current.RecordType, current.EditorId));
            else
                repository.Put(key, new SourceDocument(formKey, current.RecordType, current.EditorId, body));
        }
        index.RefreshKeys(key, [.. deltas.Select(d => d.FormKey)]);
    }
}
