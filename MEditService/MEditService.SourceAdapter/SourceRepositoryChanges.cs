using System.Text;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>A document git names as changed: the record it declares, its working-tree text (null
/// when the working tree holds no file there), and whether the validated HEAD held nothing at its
/// path.</summary>
public sealed record ChangedDocument(string FormKey, string? WorkingTreeText, bool NewPath);

/// <summary>HEAD now, null when git cannot read it, and the documents changed since the validated
/// HEAD, null when git cannot narrow them and only a whole-tree read can say.</summary>
public sealed record TreeChanges(string? Head, IReadOnlyList<ChangedDocument>? Documents);

/// <summary>Git's index is the tree's stamp (ADR-0009): at an unmoved HEAD, a document git status
/// reports clean holds what HEAD holds.</summary>
public sealed partial class SourceRepository
{
    /// <summary>Every document of the plugin's tree git reports dirty, and every one a move of HEAD
    /// since <paramref name="validatedHead"/> changed. HEAD is read first, so a commit landing
    /// mid-call is named by the next call.</summary>
    public TreeChanges ChangesSince(PluginAddress plugin, string? validatedHead)
    {
        var gitDir = Path.Combine(_modFolder, ".git");
        if (!GitCli.TryRun(gitDir, _modFolder, out var headOutput, "rev-parse", "--verify", "-q", "HEAD^{commit}"))
            return new TreeChanges(null, null);
        var head = headOutput.Trim();
        if (validatedHead is null) return new TreeChanges(head, null);

        if (ChangedPaths(gitDir, LiteralPathspec(RootFor(plugin.Name)), validatedHead, head) is not { } paths)
            return new TreeChanges(head, null);

        var documents = new List<ChangedDocument>();
        var holders = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (gitPath, newPath) in paths)
        {
            var fullPath = Path.Combine(_modFolder, gitPath.Replace('/', Path.DirectorySeparatorChar));
            // The whole-tree read's own rule for which files are documents.
            if (CarriesNoRecord(fullPath)) continue;

            if (!File.Exists(fullPath))
            {
                var committed = CommittedText(gitDir, head, gitPath) ?? CommittedText(gitDir, validatedHead, gitPath);
                if (committed is null || FormKeyDeclaredIn(committed, fullPath, plugin.Name) is not { } goneFormKey)
                    return new TreeChanges(head, null);
                documents.Add(new ChangedDocument(goneFormKey, null, newPath));
                continue;
            }

            string text;
            try
            {
                text = Encoding.UTF8.GetString(StripUtf8Bom(File.ReadAllBytes(fullPath)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new TreeChanges(head, null);
            }

            // A name that does not carry the FormKey its text declares is a copy or a hand rename,
            // and the tree's other document for that record is one git does not name.
            if (FormKeyDeclaredIn(text, fullPath, plugin.Name) is not { } formKey
                || PathCarrying([gitPath], plugin.Name, formKey) is null)
            {
                return new TreeChanges(head, null);
            }

            OneDocumentPerFormKey.Claim(holders, formKey, fullPath, _modFolder);
            documents.Add(new ChangedDocument(formKey, text, newPath));
        }
        return new TreeChanges(head, documents);
    }

    // Each named path, and whether the validated HEAD held nothing at it. --no-renames names both
    // ends of a move and -uall each file of an untracked folder. The whole-tree read counts
    // ignored files, so status lists them.
    private Dictionary<string, bool>? ChangedPaths(string gitDir, string pathspec, string validatedHead, string head)
    {
        var paths = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (head != validatedHead)
        {
            if (!GitCli.TryRun(gitDir, _modFolder, out var diff,
                    "diff-tree", "-r", "-z", "--no-renames", "--name-status", validatedHead, head, "--", pathspec))
            {
                return null;
            }
            var fields = diff.Split('\0', StringSplitOptions.RemoveEmptyEntries);
            for (var i = 0; i + 1 < fields.Length; i += 2) paths[fields[i + 1]] = fields[i] == "A";
        }

        if (!GitCli.TryRun(gitDir, _modFolder, out var status,
                "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored", "--", pathspec))
        {
            return null;
        }
        foreach (var entry in status.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            if (entry.Length < 4) continue;
            // HEAD holds nothing at an untracked, ignored or newly staged path, and neither did the
            // validated HEAD unless diff-tree already named it.
            paths.TryAdd(entry[3..], entry[0] is '?' or '!' or 'A');
        }
        return paths;
    }

    private string? CommittedText(string gitDir, string commit, string gitPath) =>
        GitCli.TryRun(gitDir, _modFolder, out var text, "cat-file", "-p", $"{commit}:{gitPath}") ? text : null;
}
