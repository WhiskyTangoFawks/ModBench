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
            .Select(row => (At: new RecordAt(new PluginAddress(row.Plugin, row.Origin), row.FormKey), Identity: new RecordIdentity(row.FormKey, row.RecordType, row.EditorId)))
            .DistinctBy(referrer => referrer.At, RecordAt.Comparer)
            .ToList();
        var trees = referrers.Select(referrer => referrer.At.Plugin).Distinct(PluginAddress.Comparer).ToDictionary(plugin => plugin, treeOf, PluginAddress.Comparer);
        var placing = new Placing(target);
        foreach (var (at, identity) in referrers)
        {
            if (trees[at.Plugin] is { } tree) placing.InFile(at, tree.DocumentOf(at.Plugin, identity), textAt);
        }

        List<RecordAt> rendered = [.. referrers.Select(referrer => referrer.At).Where(at => trees[at.Plugin] is null)];
        var held = new HashSet<RecordAt>(RecordAt.Comparer);
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
            var spans = Naming(names, copy);
            if (spans.Count > 0) _placed.Add(new PlacedCopy(copy.FormKey, copy.Plugin, RecordQueries.CopyDocumentAt(file), spans));
            else LeaveOut(copy, $"its text in {file.Path} names {target} nowhere.");
        }

        // A copy with no plugin source sits at the record that holds it (symbols.md, story 10).
        public void Rendered(RecordAt copy, Answer<string, SourceFailure> fileName, string text)
        {
            if (!fileName.Holds(out var name, out var failure))
            {
                LeaveOut(copy, failure.Reason);
                return;
            }
            var names = NamesIn(text);
            var spans = Naming(names, copy);
            if (spans.Count == 0 && Own(names, copy).Find(found => found.FieldPath == RecordMembers.FormKey) is { } declared) spans.Add(SpanOf(declared));
            if (spans.Count > 0) _placed.Add(new PlacedCopy(copy.FormKey, copy.Plugin, new CopyDocument(CopyDocumentKind.Rendered, name), spans));
            else LeaveOut(copy, $"its rendered document {name} states no {copy.FormKey}.");
        }

        public void LeaveOut(RecordAt copy, string why) => _leftOut.Add($"{ReadFailures.Copy(copy.FormKey, copy.Plugin)}: {why}");

        private List<TextSpan> Naming(IReadOnlyList<DocumentName> names, RecordAt copy) =>
            [.. Own(names, copy).Where(name => name.FieldPath != RecordMembers.FormKey && SameFormKey(name.Value, target)).Select(SpanOf)];

        private static List<DocumentName> Own(IReadOnlyList<DocumentName> names, RecordAt copy) =>
            [.. names.Where(name => name.Kind == DocumentNameKind.Record && SameFormKey(name.Record, copy.FormKey))];

        private static IReadOnlyList<DocumentName> NamesIn(string text) => DocumentNames.In(DocumentSpans.Read(text), _ => null, null);

        private static bool SameFormKey(string? name, string formKey) => string.Equals(name, formKey, StringComparison.OrdinalIgnoreCase);

        private static TextSpan SpanOf(DocumentName name) => new(name.Start, name.End);
    }
}
