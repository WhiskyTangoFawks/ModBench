using System.Text;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>How a record the tree still holds stands against the last commit.</summary>
public enum RecordChange { Modified, Added }

public sealed partial class SourceRepository
{
    /// <summary>Every record the tree holds whose text differs from the last commit's, an embedded
    /// child among them; a tree with no repository is all added. A failed read throws
    /// <see cref="UnreadableSourceDocumentException"/>, never reads as a deletion.</summary>
    public IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
        PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        using var expansion = new SourceTreeDocuments(_modFolder, plugin.Name, _release, schemas);
        var committed = new Dictionary<string, string>(StringComparer.Ordinal);
        var working = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (relativePath, heldAtLastCommit) in ChangedFiles(plugin))
        {
            var fullPath = Path.Combine(_modFolder, relativePath);
            var committedText = heldAtLastCommit
                ? ReadCommittedSourceText(_modFolder, relativePath)
                    ?? throw new UnreadableSourceDocumentException(fullPath, "git cannot read what the last commit holds for it")
                : null;
            RecordTextsIn(committed, expansion, plugin, relativePath, committedText);
            RecordTextsIn(working, expansion, plugin, relativePath, ReadWorkingText(fullPath));
        }

        var changes = new Dictionary<string, RecordChange>(StringComparer.Ordinal);
        foreach (var (formKey, text) in working)
        {
            if (!committed.TryGetValue(formKey, out var was)) changes[formKey] = RecordChange.Added;
            else if (!string.Equals(was, text, StringComparison.Ordinal)) changes[formKey] = RecordChange.Modified;
        }
        return changes;
    }

    // Git's paths use forward slashes on every platform. An index column of ?, ! or A means the last
    // commit has no such file.
    private IEnumerable<(string RelativePath, bool HeldAtLastCommit)> ChangedFiles(PluginAddress plugin)
    {
        if (WorkingTreeStatus(_modFolder, plugin.Name) is { } status)
        {
            return status.Select(entry => (
                entry.Path.Replace('/', Path.DirectorySeparatorChar), entry.Code is not ('?' or '!' or 'A')));
        }

        if (IsTracked(_modFolder))
            throw new UnreadableSourceDocumentException(_modFolder, "git cannot report what changed in its tree");

        var root = RootIn(_modFolder, plugin.Name);
        return Directory.Exists(root)
            ? Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                .Select(path => (Path.GetRelativePath(_modFolder, path), false))
            : [];
    }

    // A file a racing write took away is gone; one that exists and cannot be read is a failure.
    private static string? ReadWorkingText(string path)
    {
        try
        {
            return Encoding.UTF8.GetString(StripUtf8Bom(File.ReadAllBytes(path)));
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new UnreadableSourceDocumentException(path, $"it cannot be read ({ex.Message})");
        }
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
