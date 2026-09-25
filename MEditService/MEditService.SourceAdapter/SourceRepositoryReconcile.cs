using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>One dirty document of a plugin's tree: the record it holds, the text HEAD commits for it,
/// and whether the working tree holds it at all. Absent from both refs is not dirt.</summary>
public sealed record DirtyDocument(string FormKey, string RecordType, string? CommittedText, bool InWorkingTree);

/// <summary>The tree's dirt as records rather than as paths. NeedsStructuralPass marks dirt under the
/// plugin's own tree that names no record — a container, which only a whole-tree compare
/// reconciles.</summary>
public sealed record WorkingTreeDirt(IReadOnlyList<DirtyDocument> Documents, bool NeedsStructuralPass);

/// <summary>What a reconcile asks the tree: where its dirt leaves each record, and the documents it
/// holds now against the ones a ref committed (ADR-0003).</summary>
public sealed partial class SourceRepository
{
    /// <summary>Every record the tree's dirt moves, by identity and text. Dirt is git status, never a
    /// content-hash compare: the hash is of the codec's canonical form, so any other tree would read
    /// as wholly dirty.</summary>
    public WorkingTreeDirt DirtOf(PluginAddress plugin)
    {
        var documents = new List<DirtyDocument>();
        var needsStructuralPass = false;

        // Which plugin's subtree a dirty path sits under — not a container-path grammar (ADR-0003).
        var ownTreePrefix = $"{RootFor(plugin.Name)}{Path.DirectorySeparatorChar}";

        foreach (var gitPath in WorkingTreeStatus(_modFolder))
        {
            // git speaks forward slashes on every platform; the layout splits on the platform's
            // own separator, so a raw porcelain path would simply never parse on Windows.
            var relativePath = gitPath.Replace('/', Path.DirectorySeparatorChar);

            if (ParseDocumentPath(relativePath, _release) is not { } identity)
            {
                // Not a flat record file: a path under this plugin's own tree (a container) defers to the
                // structural pass; a path outside it carries nothing to reconcile.
                needsStructuralPass |=
                    relativePath.StartsWith(ownTreePrefix, StringComparison.OrdinalIgnoreCase);
                continue;
            }

            if (!identity.PluginFileName.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)) continue;

            var fullPath = Path.Combine(_modFolder, relativePath);
            var committedText = ReadCommittedSourceText(_modFolder, relativePath);
            var inWorkingTree = File.Exists(fullPath);

            if (identity.RecordType == PluginHeader.RecordType)
            {
                // The header's FormKey is computed, since a ModHeader cannot flow through the per-record
                // codec and the structural pass cannot reach it either.
                if (inWorkingTree || committedText != null)
                {
                    documents.Add(new DirtyDocument(
                        PluginHeader.FormKeyFor(ModKey.FromFileName(identity.PluginFileName)),
                        PluginHeader.RecordType, committedText, inWorkingTree));
                }
                continue;
            }

            if (!inWorkingTree)
            {
                // Deleted in the working tree: gone at Effective, and it must keep answering at Head so
                // the user can see, diff or revert it (ADR-0007).
                if (committedText == null) continue;
                var goneFormKey = RootStringIn(committedText, FormKeyMember)
                    ?? throw new UnreadableSourceDocumentException(
                        fullPath, "the text HEAD committed for it declares no FormKey");
                documents.Add(
                    new DirtyDocument(goneFormKey, identity.RecordType, committedText, InWorkingTree: false));
                continue;
            }

            // Identity from the document, not the path: an EditorID may contain " - ". Null covers an
            // unreadable file as well as one declaring nothing, and a file that races this read is
            // exactly what must degrade visibly rather than go missing.
            var formKey = FormKeyDeclaredBy(fullPath, plugin.Name)
                ?? throw new UnreadableSourceDocumentException(fullPath, "it declares no FormKey");
            documents.Add(new DirtyDocument(formKey, identity.RecordType, committedText, InWorkingTree: true));
        }

        return new WorkingTreeDirt(documents, needsStructuralPass);
    }

    /// <summary>The plugin's tree as the documents it holds right now, each record's own. The caller
    /// disposes it; nothing is deserialized into a mod.</summary>
    public IPluginDocuments OpenDocuments(
        PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        new SourceTreeDocuments(_modFolder, plugin.Name, _release, schemas);

    /// <summary>The same documents as <paramref name="gitRef"/> committed them, a container's embedded
    /// children among them. Straight from the object store: no checkout, no second working tree.</summary>
    public IEnumerable<PluginDocument> DocumentsAt(
        PluginAddress plugin, string gitRef, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        using var tree = new SourceTreeDocuments(_modFolder, plugin.Name, _release, schemas);
        foreach (var document in ReadAll(plugin, gitRef))
        {
            foreach (var expanded in tree.Expand(document.RecordType, document.FormKey, document.Body))
                yield return expanded;
        }
    }

    private const string FormKeyMember = "FormKey";
}
