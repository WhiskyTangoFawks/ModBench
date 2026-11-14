using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>A copy of a record in plugin source that attaches a script: its file, and the member paths that name it.</summary>
public sealed record ScriptCopyFile(string FormKey, PluginAddress Plugin, IReadOnlyList<string> FieldPaths, string File);

/// <summary>The text each document holds once a script's references follow its rename, each plugin whose source changes,
/// and each reference left behind, saying why.</summary>
public sealed record ScriptRenameSourceChanges(
    IReadOnlyList<DocumentChange> Documents, IReadOnlyList<PluginAddress> Plugins, IReadOnlyList<string> LeftBehind);

/// <summary>Plugin source's part in renaming a Papyrus script: each member that names it takes the new name, as changes
/// VS Code applies and saves (ADR-0028).</summary>
public sealed class ScriptRenameSourceChangesHandler
{
    private readonly ISourceAdapter _source;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal ScriptRenameSourceChangesHandler(ISourceAdapter source) => _source = source;

    /// <summary>The changes renaming <paramref name="name"/> makes to <paramref name="copies"/>' files, over the unsaved
    /// documents mEdit holds, written nowhere (ADR-0001).</summary>
    public ScriptRenameSourceChanges Changes(string name, string newName, IReadOnlyList<ScriptCopyFile> copies)
    {
        var texts = new Dictionary<string, string>(StringComparer.Ordinal);
        var spans = new Dictionary<string, List<(int Start, int End)>>(StringComparer.Ordinal);
        var plugins = new List<PluginAddress>();
        var leftBehind = new List<string>();
        foreach (var copy in copies)
        {
            var named = $"{copy.FormKey} in {copy.Plugin.Name} ({copy.Plugin.Origin})";
            if (!texts.TryGetValue(copy.File, out var text))
            {
                try
                {
                    text = _source.TextAt(copy.File);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    leftBehind.Add($"{named}: {ex.Message}");
                    continue;
                }
                texts[copy.File] = text;
            }
            var naming = DocumentSpans.Read(text).StringsAt(copy.FormKey, copy.FieldPaths)
                .Where(found => found.Value.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (naming.Count < copy.FieldPaths.Count)
            {
                leftBehind.Add($"{named}: its plugin source does not name {name} at {string.Join(", ", copy.FieldPaths)}");
                continue;
            }
            spans[copy.File] = [.. spans.GetValueOrDefault(copy.File) ?? [], .. naming.Select(found => (found.Start, found.End))];
            if (!plugins.Contains(copy.Plugin, PluginAddress.Comparer)) plugins.Add(copy.Plugin);
        }
        var spelled = JsonSerializer.Serialize(newName)[1..^1];
        return new(
            [.. spans.Select(file => new DocumentChange(file.Key, Spliced(texts[file.Key], file.Value, spelled)))],
            plugins,
            leftBehind);
    }

    private static string Spliced(string text, List<(int Start, int End)> spans, string spelled) =>
        spans.OrderByDescending(span => span.Start).Aggregate(text, (after, span) => after[..span.Start] + spelled + after[span.End..]);
}
