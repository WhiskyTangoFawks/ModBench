using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>Each copy that references a record, at its document: its file in plugin source, else its rendered document.
/// A copy that cannot be placed is left out, saying why.</summary>
internal static class ReferencePlacement
{
    public static PlacedReferences Of(
        RelationReads reads, string target, Func<PluginAddress, ISourceRepositoryReads?> treeOf,
        Func<PluginAddress, RecordIdentity, Answer<string, SourceFailure>> renderedFileName, Func<string, string> textAt)
    {
        var referrers = reads.GetReferencedByInActiveOrCompiledPlugins(target)
            .Select(row => (Plugin: new PluginAddress(row.Plugin, row.Origin), Identity: new RecordIdentity(row.FormKey, row.RecordType, row.EditorId)))
            .Distinct()
            .ToList();
        var trees = referrers.Select(referrer => referrer.Plugin).Distinct(PluginAddress.Comparer).ToDictionary(plugin => plugin, treeOf, PluginAddress.Comparer);
        var placing = new Placing(target);
        foreach (var (plugin, identity) in referrers)
        {
            if (trees[plugin] is { } tree) placing.InFile(new RecordAt(plugin, identity.FormKey), tree.DocumentOf(plugin, identity), textAt);
        }

        List<RecordAt> rendered = [.. referrers.Where(referrer => trees[referrer.Plugin] is null).Select(referrer => new RecordAt(referrer.Plugin, referrer.Identity.FormKey))];
        var held = new HashSet<RecordAt>();
        foreach (var copy in reads.GetCopies(rendered))
        {
            var at = new RecordAt(copy.Plugin, copy.FormKey);
            held.Add(at);
            placing.Rendered(at, renderedFileName(copy.Plugin, new RecordIdentity(copy.FormKey, copy.RecordType, copy.EditorId)), copy.Body);
        }
        foreach (var copy in rendered.Where(copy => !held.Contains(copy))) placing.LeaveOut(copy, $"{copy.Plugin.Name} holds no copy of it.");
        return placing.Placed;
    }

    private sealed class Placing(string target)
    {
        private readonly List<PlacedCopy> _placed = [];
        private readonly List<string> _leftOut = [];
        private readonly Dictionary<string, IReadOnlyList<DocumentName>> _files = new(StringComparer.Ordinal);

        public PlacedReferences Placed => new(_placed, _leftOut);

        public void InFile(RecordAt copy, Answer<DocumentFile?, SourceFailure> located, Func<string, string> textAt)
        {
            if (!located.Holds(out var file, out var failure))
            {
                LeaveOut(copy, failure.Reason);
                return;
            }
            if (file is null)
            {
                LeaveOut(copy, "its plugin source holds no file for it.");
                return;
            }
            if (!_files.TryGetValue(file.Path, out var names))
            {
                try
                {
                    names = NamesIn(textAt(file.Path));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    LeaveOut(copy, $"{file.Path} could not be read: {ex.Message}");
                    return;
                }
                _files[file.Path] = names;
            }
            Place(copy, new CopyDocument(file.IsContainersDocument ? CopyDocumentKind.ContainersFile : CopyDocumentKind.OwnFile, file.Path), names);
        }

        public void Rendered(RecordAt copy, Answer<string, SourceFailure> fileName, string text)
        {
            if (fileName.Holds(out var name, out var failure)) Place(copy, new CopyDocument(CopyDocumentKind.Rendered, name), NamesIn(text));
            else LeaveOut(copy, failure.Reason);
        }

        public void LeaveOut(RecordAt copy, string why) => _leftOut.Add($"{ReadFailures.Copy(copy.FormKey, copy.Plugin)}: {why}");

        private void Place(RecordAt copy, CopyDocument document, IReadOnlyList<DocumentName> names)
        {
            var own = names.Where(name => name.Kind == DocumentNameKind.Record && SameFormKey(name.Record, copy.FormKey)).ToList();
            List<TextSpan> spans = [.. own.Where(name => name.FieldPath != RecordMembers.FormKey && SameFormKey(name.Value, target)).Select(SpanOf)];
            if (spans.Count == 0 && own.Find(name => name.FieldPath == RecordMembers.FormKey) is { } declared) spans.Add(SpanOf(declared));
            if (spans.Count == 0) LeaveOut(copy, $"{document.Location} states no {copy.FormKey}.");
            else _placed.Add(new PlacedCopy(copy.FormKey, copy.Plugin, document, spans));
        }

        private static IReadOnlyList<DocumentName> NamesIn(string text) => DocumentNames.In(DocumentSpans.Read(text), _ => null, null);

        private static bool SameFormKey(string? name, string formKey) => string.Equals(name, formKey, StringComparison.OrdinalIgnoreCase);

        private static TextSpan SpanOf(DocumentName name) => new(name.Start, name.End);
    }
}
