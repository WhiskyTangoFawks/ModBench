using System.Text;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A document git names as changed: the record it declares, and its working-tree text (null
/// when the working tree holds no file there).</summary>
public sealed record ChangedDocument(string FormKey, string? WorkingTreeText);

/// <summary>A document file git names, and its working-tree text (null when the working tree holds
/// no file there).</summary>
public sealed record NamedFile(string GitPath, string? WorkingTreeText);

/// <summary>HEAD now, null when git cannot read it; the documents changed since the validated HEAD,
/// null when only a whole-tree read can say; and each document file git named, null when it
/// could not.</summary>
public sealed record TreeChanges(string? Head, IReadOnlyList<ChangedDocument>? Documents, IReadOnlyList<NamedFile>? Named);

/// <summary>Git's index as the tree's stamp (ADR-0009, Derived tactical observations).</summary>
public sealed partial class SourceRepository
{
    /// <summary>Every document of the plugin's tree git reports dirty, and every one a move of HEAD
    /// since <paramref name="validatedHead"/> changed. HEAD is read first, so a commit landing
    /// mid-call is named by the next call.</summary>
    public TreeChanges ChangesSince(PluginAddress plugin, string? validatedHead)
    {
        var gitDir = Path.Combine(_modFolder, ".git");
        if (!GitCli.TryRun(gitDir, _modFolder, out var headOutput, "rev-parse", "--verify", "-q", "HEAD^{commit}"))
            return new TreeChanges(null, null, null);
        var head = headOutput.Trim();
        if (validatedHead is null) return new TreeChanges(head, null, null);

        if (ChangedPaths(gitDir, plugin, validatedHead, head) is not { } paths) return new TreeChanges(head, null, null);

        // The whole-tree read's own rule for which files are documents.
        var named = paths
            .Select(path => (Path: path.Key, NewPath: path.Value, FullPath: Path.GetFullPath(
                Path.Combine(_modFolder, path.Key.Replace('/', Path.DirectorySeparatorChar)))))
            .Where(path => !CarriesNoRecord(path.FullPath))
            .Select(path => (path.Path, path.NewPath, path.FullPath, Text: File.Exists(path.FullPath) ? ReadOrNull(path.FullPath) : null))
            .ToList();
        var files = named.Select(file => new NamedFile(file.Path, file.Text)).ToList();
        return new TreeChanges(head, DocumentsNamed(plugin, named, head, validatedHead), files);
    }

    // Null when a named file says too little to key its document by.
    private List<ChangedDocument>? DocumentsNamed(
        PluginAddress plugin, List<(string Path, bool NewPath, string FullPath, string? Text)> named, string head,
        string validatedHead)
    {
        var documents = new List<ChangedDocument>();
        foreach (var (gitPath, newPath, fullPath, text) in named)
        {
            if (!File.Exists(fullPath))
            {
                var committed = ReadCommittedSourceText(_modFolder, gitPath, head)
                    ?? ReadCommittedSourceText(_modFolder, gitPath, validatedHead);
                if (committed is null || FormKeyDeclaredIn(committed, fullPath, plugin.Name) is not { } goneFormKey)
                    return null;
                documents.Add(new ChangedDocument(goneFormKey, null));
                continue;
            }

            // A name not carrying the FormKey its text declares, or a new path beside another document
            // naming that FormKey, is a copy or a hand rename whose twin git does not name.
            if (text is null
                || FormKeyDeclaredIn(text, fullPath, plugin.Name) is not { } formKey
                || !FormKey.TryFactory(formKey, out _)
                || PathCarrying([gitPath], plugin.Name, formKey) is null
                || (newPath && HoldsAnotherDocumentNaming(plugin, formKey, fullPath)))
            {
                return null;
            }
            documents.Add(new ChangedDocument(formKey, text));
        }
        return documents;
    }

    /// <summary>Which of <paramref name="formKeys"/> HEAD holds, as a document or as a child another
    /// document embeds; null when git cannot say. One git grep finds the committed files naming any
    /// of them, and those are read first.</summary>
    public IReadOnlySet<string>? HeldAtHead(PluginAddress plugin, IReadOnlyCollection<string> formKeys)
    {
        var held = new HashSet<string>(StringComparer.Ordinal);
        var wanted = new Dictionary<FormKey, string>();
        var header = HeaderFormKeyOf(plugin.Name);
        foreach (var formKey in formKeys)
        {
            // The header's document declares a ModKey, so no committed text carries its FormKey.
            if (formKey.Equals(header, StringComparison.OrdinalIgnoreCase))
            {
                if (ReadCommittedSourceText(_modFolder, HeaderDocumentFor(plugin.Name)) is not null) held.Add(formKey);
            }
            else if (FormKey.TryFactory(formKey, out var parsed))
            {
                wanted[parsed] = formKey;
            }
        }
        if (wanted.Count == 0) return held;

        var gitDir = Path.Combine(_modFolder, ".git");
        string[] args =
        [
            "grep", "-l", "-z", "-i", "-F", .. wanted.Values.SelectMany(formKey => new[] { "-e", formKey }),
            "HEAD", "--", LiteralPathspec(RootFor(plugin.Name)),
        ];
        // git grep exits 1 when nothing matched.
        if (GitCli.RunForExitCode(gitDir, _modFolder, out var files, args) is not (0 or 1)) return null;

        const string treePrefix = "HEAD:";
        var hits = files.Split('\0', StringSplitOptions.RemoveEmptyEntries).Select(hit => hit[treePrefix.Length..]).ToList();
        if (!CreditCommitted(gitDir, plugin, hits, wanted, held)) return null;
        if (wanted.Values.All(held.Contains)) return held;

        // A FormKey written through a JSON escape escapes the search, so a miss reads the rest of HEAD's
        // tree before it counts as gone.
        if (CommittedSourceTree(_modFolder, plugin.Name) is not { } listing) return null;
        var rest = listing.Keys.Except(hits, StringComparer.Ordinal).Where(path => !CarriesNoRecord(path)).ToList();
        return CreditCommitted(gitDir, plugin, rest, wanted, held) ? held : null;
    }

    // One cat-file for every path. False when git cannot read one of them.
    private bool CreditCommitted(
        string gitDir, PluginAddress plugin, List<string> gitPaths, Dictionary<FormKey, string> wanted, HashSet<string> held)
    {
        if (gitPaths.Count == 0) return true;
        if (GitCli.CatFileBatch(gitDir, _modFolder, [.. gitPaths.Select(path => $"HEAD:{path}")]) is not { } contents)
            return false;

        foreach (var (gitPath, content) in gitPaths.Zip(contents))
        {
            if (content is null) return false;
            var bytes = StripUtf8Bom(content);
            if (FormKeyDeclaredIn(Encoding.UTF8.GetString(bytes), gitPath, plugin.Name) is { } declared
                && FormKey.TryFactory(declared, out var own) && wanted.TryGetValue(own, out var document))
            {
                held.Add(document);
            }
            foreach (var (formKey, _, inAnEmbedSlot) in FormKeysIn(bytes, _release))
            {
                if (inAnEmbedSlot && FormKey.TryFactory(formKey, out var parsed) && wanted.TryGetValue(parsed, out var child))
                    held.Add(child);
            }
        }
        return true;
    }

    // Each named path, and whether the validated HEAD held nothing at it.
    private Dictionary<string, bool>? ChangedPaths(string gitDir, PluginAddress plugin, string validatedHead, string head)
    {
        var paths = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (head != validatedHead)
        {
            if (!GitCli.TryRun(gitDir, _modFolder, out var diff,
                    "diff-tree", "-r", "-z", "--no-renames", "--name-status", validatedHead, head,
                    "--", LiteralPathspec(RootFor(plugin.Name))))
            {
                return null;
            }
            var fields = diff.Split('\0', StringSplitOptions.RemoveEmptyEntries);
            for (var i = 0; i + 1 < fields.Length; i += 2) paths[fields[i + 1]] = fields[i] == "A";
        }

        if (WorkingTreeStatus(_modFolder, plugin.Name) is not { } status) return null;
        // HEAD holds nothing at an untracked, ignored or newly staged path.
        foreach (var (code, gitPath) in status) paths.TryAdd(gitPath, code is '?' or '!' or 'A');
        return paths;
    }

    private bool HoldsAnotherDocumentNaming(PluginAddress plugin, string formKey, string fullPath) =>
        DocumentsNaming(Path.Combine(_modFolder, RootFor(plugin.Name)), formKey)
            .Any(other => File.Exists(other) && !Path.GetFullPath(other).Equals(fullPath, StringComparison.Ordinal));
}
