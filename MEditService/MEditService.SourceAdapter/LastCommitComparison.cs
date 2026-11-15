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
    /// <summary>The records of the files under <paramref name="within"/>, relative to the source folder, or of the whole tree
    /// when null. A record no file there held at the last commit is added.</summary>
    internal static IReadOnlyDictionary<string, RecordChange> Of(
        string sourceFolder, GameRelease release, SourceRepositoryGit git, SourceRepositoryLocator locator,
        PluginAddress plugin, IReadOnlyList<string>? within = null)
    {
        using var expansion = new SourceTreeDocuments(sourceFolder, plugin.Name, release, DiskFiles.Instance);
        var committed = new Dictionary<string, string>(StringComparer.Ordinal);
        var working = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var (relativePath, heldAtLastCommit) in ChangedFiles(sourceFolder, git, plugin, within))
        {
            var fullPath = Path.Combine(sourceFolder, relativePath);
            var committedText = heldAtLastCommit
                ? git.ReadCommittedSourceText(relativePath)
                    ?? throw SourceStopException.GitFailed($"git cannot read what the last commit holds for '{fullPath}'.")
                : null;
            RecordTextsIn(committed, locator, expansion, plugin, relativePath, committedText);
            var workingText = ReadWorkingText(fullPath);
            if (workingText is not null) locator.RequireParsedFormKey(relativePath, workingText, plugin.Name);
            RecordTextsIn(working, locator, expansion, plugin, relativePath, workingText);
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
        string sourceFolder, SourceRepositoryGit git, PluginAddress plugin, IReadOnlyList<string>? within)
    {
        if ((within is null ? git.WorkingTreeStatus(plugin.Name) : git.WorkingTreeStatus(within)) is { } status)
        {
            return status.Select(entry => (
                entry.Path.Replace('/', Path.DirectorySeparatorChar), entry.Code is not ('?' or '!' or 'A')));
        }

        if (SourceRepositoryGit.HoldsSourceMod(sourceFolder))
            throw SourceStopException.GitFailed($"git cannot report what changed in '{sourceFolder}'.");

        return (within?.Select(path => Path.Combine(sourceFolder, path)) ?? [SourceRepositoryLayout.RootIn(sourceFolder, plugin.Name)])
            .SelectMany(FilesAt)
            .Select(path => (Path.GetRelativePath(sourceFolder, path), false));
    }

    private static IEnumerable<string> FilesAt(string path)
    {
        if (Directory.Exists(path)) return Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories);
        return File.Exists(path) ? [path] : [];
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
