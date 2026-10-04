using MEditService.Codec.Schema;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>How a record stands against the last commit.</summary>
public enum RecordChange { Modified, Added, Deleted }

public sealed partial class SourceRepository
{
    /// <summary>Every record whose text differs from the last commit's, by FormKey, an embedded child
    /// among them. Compared by text: a content hash cannot tell a changed file from a differently
    /// spelled one.</summary>
    public IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
        PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        using var expansion = new SourceTreeDocuments(_modFolder, plugin.Name, _release, schemas);
        var committed = new Dictionary<string, string>(StringComparer.Ordinal);
        var working = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var relativePath in ChangedFiles(plugin))
        {
            var fullPath = Path.Combine(_modFolder, relativePath);
            RecordTextsIn(committed, expansion, plugin, relativePath, ReadCommittedSourceText(_modFolder, relativePath));
            RecordTextsIn(working, expansion, plugin, relativePath, File.Exists(fullPath) ? ReadOrNull(fullPath) : null);
        }

        var changes = new Dictionary<string, RecordChange>(StringComparer.Ordinal);
        foreach (var (formKey, text) in working)
        {
            if (!committed.TryGetValue(formKey, out var was)) changes[formKey] = RecordChange.Added;
            else if (!string.Equals(was, text, StringComparison.Ordinal)) changes[formKey] = RecordChange.Modified;
        }
        foreach (var formKey in committed.Keys.Where(formKey => !working.ContainsKey(formKey)))
            changes[formKey] = RecordChange.Deleted;
        return changes;
    }

    // Git's paths use forward slashes on every platform. When git cannot say, every file is a candidate.
    private IEnumerable<string> ChangedFiles(PluginAddress plugin)
    {
        if (WorkingTreeStatus(_modFolder, plugin.Name) is { } status)
            return status.Select(entry => entry.Path.Replace('/', Path.DirectorySeparatorChar));

        var root = RootIn(_modFolder, plugin.Name);
        return Directory.Exists(root)
            ? Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                .Select(path => Path.GetRelativePath(_modFolder, path))
            : [];
    }

    private void RecordTextsIn(
        Dictionary<string, string> texts, SourceTreeDocuments expansion, PluginAddress plugin,
        string relativePath, string? fileText)
    {
        if (fileText is null || DocumentAt(relativePath, fileText, plugin.Name) is not { } document) return;

        if (document.RecordType == PluginHeader.RecordType)
        {
            texts[document.FormKey] = document.Body;
            return;
        }

        foreach (var record in expansion.Expand(document.RecordType, document.FormKey, document.Body))
            texts[record.FormKey] = record.Text;
    }
}
