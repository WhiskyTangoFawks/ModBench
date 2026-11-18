using System.Diagnostics.CodeAnalysis;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.RecordIndex.Queries;

/// <summary>Of the names a copy's record holds in its document, those that are the symbol.</summary>
internal delegate IEnumerable<DocumentName> NamesOf(RecordAt copy, IEnumerable<DocumentName> recordNames);

/// <summary>What names the symbol in a document. <paramref name="UnnamedRenderedAtStart"/> places a rendered document that
/// names it nowhere, such as a plugin header, at the start of its text, where otherwise its own FormKey, else the copy is
/// left out.</summary>
internal sealed record Naming(string Symbol, NamesOf Of, Func<string, IReadOnlyList<ColumnSpec>?> ColumnsOf, bool UnnamedRenderedAtStart);

/// <summary>Each copy that names a symbol, at its document: its file in plugin source, else its rendered document.
/// A copy that cannot be placed is left out, saying why.</summary>
internal sealed class ReferencePlacement(
    Func<PluginAddress, ISourceRepositoryReads?> treeOf, Func<PluginAddress, RecordIdentity, Answer<string, SourceFailure>> renderedFileName,
    Func<string, string> textAt)
{
    public PlacedReferences Of(
        RelationReads reads, Naming naming, IEnumerable<(RecordAt At, RecordIdentity Identity)> named, IEnumerable<string> unread, CancellationToken cancel)
    {
        var referrers = named.DistinctBy(referrer => referrer.At, RecordAt.Comparer).ToList();
        var trees = referrers.Select(referrer => referrer.At.Plugin).Distinct(PluginAddress.Comparer).ToDictionary(plugin => plugin, treeOf, PluginAddress.Comparer);
        var placing = new Placing(naming, unread);
        foreach (var (at, identity) in referrers)
        {
            cancel.ThrowIfCancellationRequested();
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

    private sealed class Placing(Naming naming, IEnumerable<string> unread)
    {
        private readonly List<PlacedCopy> _placed = [];
        private readonly List<string> _leftOut = [.. unread];
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
                    document = ReadDocument.From(textAt(file.Path), naming.ColumnsOf);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    LeaveOut(copy, $"{file.Path} could not be read: {ex.Message}");
                    return;
                }
                _files[file.Path] = document;
            }
            var ranges = document.RangesOf(naming.Of(copy, document.RecordNames(copy)));
            if (ranges.Count > 0) _placed.Add(new PlacedCopy(copy.FormKey, copy.Plugin, RecordQueries.CopyDocumentAt(file), ranges));
            else LeaveOut(copy, $"its text in {file.Path} names {naming.Symbol} nowhere.");
        }

        // A copy with no plugin source sits at the record that holds it (symbols.md, story 10).
        public void Rendered(RecordAt copy, Answer<string, SourceFailure> fileName, string text)
        {
            if (!Answered(copy, fileName, out var name)) return;
            var document = ReadDocument.From(text, naming.ColumnsOf);
            var references = naming.Of(copy, document.RecordNames(copy)).ToList();
            if (references.Count == 0 && document.RecordNames(copy).FirstOrDefault(found => found.Kind == DocumentNameKind.Record && found.FieldPath == RecordMembers.FormKey) is { } declared) references.Add(declared);
            var ranges = document.RangesOf(references);
            if (ranges.Count == 0 && naming.UnnamedRenderedAtStart) ranges.Add(document.Lines.RangeOf(0, 0));
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
    }

    private sealed record ReadDocument(ILookup<string, DocumentName> NamesByRecord, TextLines Lines)
    {
        public static ReadDocument From(string text, Func<string, IReadOnlyList<ColumnSpec>?> columnsOf) =>
            new(DocumentNames.In(DocumentSpans.Read(text), columnsOf, null).ToLookup(name => name.Record ?? string.Empty, StringComparer.OrdinalIgnoreCase), new TextLines(text));

        public IEnumerable<DocumentName> RecordNames(RecordAt copy) => NamesByRecord[copy.FormKey];

        public List<SourceRange> RangesOf(IEnumerable<DocumentName> names) => [.. names.Select(name => Lines.RangeOf(name.Start, name.End))];
    }
}
