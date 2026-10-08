using System.Text;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>How a record the tree still holds stands against the last commit.</summary>
public enum RecordChange { Modified, Added }

/// <summary>The records of a plugin's tree whose text differs from the last commit's.</summary>
internal static class LastCommitComparison
{
    internal static IReadOnlyDictionary<string, RecordChange> Of(
        string modFolder, GameRelease release, SourceRepositoryGit git, SourceRepositoryLocator locator,
        PluginAddress plugin)
    {
        using var expansion = new SourceTreeDocuments(modFolder, plugin.Name, release);
        var committed = new Dictionary<string, string>(StringComparer.Ordinal);
        var working = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (relativePath, heldAtLastCommit) in ChangedFiles(modFolder, git, plugin))
        {
            var fullPath = Path.Combine(modFolder, relativePath);
            var committedText = heldAtLastCommit
                ? git.ReadCommittedSourceText(relativePath)
                    ?? throw new GitCommandFailedException($"git cannot read what the last commit holds for '{fullPath}'.")
                : null;
            RecordTextsIn(committed, locator, expansion, plugin, relativePath, committedText);
            RecordTextsIn(working, locator, expansion, plugin, relativePath, ReadWorkingText(fullPath));
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
    private static IEnumerable<(string RelativePath, bool HeldAtLastCommit)> ChangedFiles(
        string modFolder, SourceRepositoryGit git, PluginAddress plugin)
    {
        if (git.WorkingTreeStatus(plugin.Name) is { } status)
        {
            return status.Select(entry => (
                entry.Path.Replace('/', Path.DirectorySeparatorChar), entry.Code is not ('?' or '!' or 'A')));
        }

        if (SourceRepositoryGit.IsTracked(modFolder))
            throw new GitCommandFailedException($"git cannot report what changed in '{modFolder}'.");

        var root = SourceRepositoryLayout.RootIn(modFolder, plugin.Name);
        return Directory.Exists(root)
            ? Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                .Select(path => (Path.GetRelativePath(modFolder, path), false))
            : [];
    }

    // A file a racing write took away is gone. One another process holds throws as it is, so the
    // read is retried rather than remembered as a document that does not parse (ADR-0003).
    private static string? ReadWorkingText(string path)
    {
        try
        {
            return Encoding.UTF8.GetString(DocumentText.StripUtf8Bom(File.ReadAllBytes(path)));
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    private static void RecordTextsIn(
        Dictionary<string, string> texts, SourceRepositoryLocator locator, SourceTreeDocuments expansion, PluginAddress plugin,
        string relativePath, string? fileText)
    {
        if (fileText is null || locator.DocumentAt(relativePath, fileText, plugin.Name) is not { } document) return;

        if (document.RecordType == PluginHeader.RecordType)
        {
            texts[document.FormKey] = document.Body;
            return;
        }

        foreach (var record in expansion.Expand(document.RecordType, document.FormKey, document.Body))
            texts[record.FormKey] = record.Text;
    }
}
