using System.Diagnostics.CodeAnalysis;
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
        private readonly Dictionary<string, ReadDocument> _files = new(StringComparer.Ordinal);

        public PlacedReferences Placed => new(_placed, _leftOut);

        public void InFile(RecordAt copy, Answer<DocumentFile?, SourceFailure> located, Func<string, string> textAt)
        {
            if (!Answered(copy, located, out var file)) return;
            if (file is null)
            {
                LeaveOut(copy, "its plugin source holds no file for it.");
                return;
            }
            if (!_files.TryGetValue(file.Path, out var document))
            {
                try
                {
                    document = ReadDocument.From(textAt(file.Path));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    LeaveOut(copy, $"{file.Path} could not be read: {ex.Message}");
                    return;
                }
                _files[file.Path] = document;
            }
            var ranges = document.RangesOf(ReferencesIn(document.Names, copy));
            if (ranges.Count > 0) _placed.Add(new PlacedCopy(copy.FormKey, copy.Plugin, RecordQueries.CopyDocumentAt(file), ranges));
            else LeaveOut(copy, $"its text in {file.Path} names {target} nowhere.");
        }

        // A copy with no plugin source sits at the record that holds it (symbols.md, story 10).
        public void Rendered(RecordAt copy, Answer<string, SourceFailure> fileName, string text)
        {
            if (!Answered(copy, fileName, out var name)) return;
            var document = ReadDocument.From(text);
            var references = ReferencesIn(document.Names, copy);
            if (references.Count == 0 && Own(document.Names, copy).Find(found => found.FieldPath == RecordMembers.FormKey) is { } declared) references.Add(declared);
            var ranges = document.RangesOf(references);
            if (ranges.Count > 0) _placed.Add(new PlacedCopy(copy.FormKey, copy.Plugin, new CopyDocument(CopyDocumentKind.Rendered, name), ranges));
            else LeaveOut(copy, $"its rendered document {name} states no {copy.FormKey}.");
        }

        public void LeaveOut(RecordAt copy, string why) => _leftOut.Add($"{ReadFailures.Copy(copy.FormKey, copy.Plugin)}: {why}");

        private bool Answered<T>(RecordAt copy, Answer<T, SourceFailure> answer, [MaybeNullWhen(false)] out T value)
        {
            if (answer.Holds(out value, out var failure)) return true;
            LeaveOut(copy, failure.Reason);
            return false;
        }

        private List<DocumentName> ReferencesIn(IReadOnlyList<DocumentName> names, RecordAt copy) =>
            [.. Own(names, copy).Where(name => name.FieldPath != RecordMembers.FormKey && SameFormKey(name.Value, target))];

        private static List<DocumentName> Own(IReadOnlyList<DocumentName> names, RecordAt copy) =>
            [.. names.Where(name => name.Kind == DocumentNameKind.Record && SameFormKey(name.Record, copy.FormKey))];

        private static bool SameFormKey(string? name, string formKey) => string.Equals(name, formKey, StringComparison.OrdinalIgnoreCase);
    }

    private sealed record ReadDocument(IReadOnlyList<DocumentName> Names, TextLines Lines)
    {
        public static ReadDocument From(string text) => new(DocumentNames.In(DocumentSpans.Read(text), _ => null, null), new TextLines(text));

        public List<SourceRange> RangesOf(IEnumerable<DocumentName> names) => [.. names.Select(name => Lines.RangeOf(name.Start, name.End))];
    }
}
