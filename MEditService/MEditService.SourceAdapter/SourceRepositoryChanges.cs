using System.Text;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A document git names as changed: the record it declares, and its working-tree text (null
/// when the working tree holds no file there).</summary>
public sealed record ChangedDocument(string FormKey, string? WorkingTreeText);

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

        if (ChangedPaths(gitDir, plugin, validatedHead, head) is not { } paths) return new TreeChanges(head, null);

        var documents = new List<ChangedDocument>();
        foreach (var (gitPath, newPath) in paths)
        {
            var fullPath = Path.GetFullPath(Path.Combine(_modFolder, gitPath.Replace('/', Path.DirectorySeparatorChar)));
            // The whole-tree read's own rule for which files are documents.
            if (CarriesNoRecord(fullPath)) continue;

            if (!File.Exists(fullPath))
            {
                var committed = ReadCommittedSourceText(_modFolder, gitPath, head)
                    ?? ReadCommittedSourceText(_modFolder, gitPath, validatedHead);
                if (committed is null || FormKeyDeclaredIn(committed, fullPath, plugin.Name) is not { } goneFormKey)
                    return new TreeChanges(head, null);
                documents.Add(new ChangedDocument(goneFormKey, null));
                continue;
            }

            // A name not carrying the FormKey its text declares, or a new path beside another document
            // naming that FormKey, is a copy or a hand rename whose twin git does not name.
            if (ReadOrNull(fullPath) is not { } text
                || FormKeyDeclaredIn(text, fullPath, plugin.Name) is not { } formKey
                || !FormKey.TryFactory(formKey, out _)
                || PathCarrying([gitPath], plugin.Name, formKey) is null
                || (newPath && HoldsAnotherDocumentNaming(plugin, formKey, fullPath)))
            {
                return new TreeChanges(head, null);
            }
            documents.Add(new ChangedDocument(formKey, text));
        }
        return new TreeChanges(head, documents);
    }

    /// <summary>Which of <paramref name="formKeys"/> HEAD holds, as a document or as a child another
    /// document embeds; null when git cannot say. One git grep finds the committed files naming any
    /// of them, and only those are read.</summary>
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
        switch (GitCli.RunForExitCode(gitDir, _modFolder, out var files, args))
        {
            case 1: return held;
            case not 0: return null;
        }

        const string treePrefix = "HEAD:";
        foreach (var hit in files.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            var gitPath = hit[treePrefix.Length..];
            if (ReadCommittedSourceText(_modFolder, gitPath) is not { } text) return null;

            if (FormKeyDeclaredIn(text, gitPath, plugin.Name) is { } declared
                && FormKey.TryFactory(declared, out var own) && wanted.TryGetValue(own, out var document))
            {
                held.Add(document);
            }
            foreach (var (formKey, _, inAnEmbedSlot) in FormKeysIn(Encoding.UTF8.GetBytes(text), _release))
            {
                if (inAnEmbedSlot && FormKey.TryFactory(formKey, out var parsed) && wanted.TryGetValue(parsed, out var child))
                    held.Add(child);
            }
        }
        return held;
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
