using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>Where a copy of a record that attaches a script sits: in a file of plugin source, or why in none.</summary>
public enum ScriptCopyPlace
{
    File,
    NoPluginSource,
    NoCopy,
    Rendered,
    Unread,
}

/// <summary>A copy of a record that attaches a script, and the member paths that name it. <paramref name="At"/> is its file
/// in plugin source, or why the record index could not say where it sits.</summary>
public sealed record ScriptCopyFile(string FormKey, PluginAddress Plugin, IReadOnlyList<string> FieldPaths, ScriptCopyPlace Place, string? At = null);

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

    /// <summary>The changes renaming <paramref name="name"/> makes to the files of <paramref name="copies"/>, over the
    /// unsaved documents mEdit holds, written nowhere (ADR-0001). <paramref name="unread"/> says why a copy went unread.</summary>
    public ScriptRenameSourceChanges Changes(string name, string newName, IReadOnlyList<ScriptCopyFile> copies, IReadOnlyList<string> unread)
    {
        var texts = new Dictionary<string, string>(StringComparer.Ordinal);
        var spans = new Dictionary<string, List<(int Start, int End)>>(StringComparer.Ordinal);
        var plugins = new List<PluginAddress>();
        var leftBehind = new List<string>();
        foreach (var copy in copies.Where(copy => copy.Place != ScriptCopyPlace.NoPluginSource))
        {
            if (WhyLeftBehind(copy, texts) is { } why)
            {
                leftBehind.Add(why);
                continue;
            }
            var file = copy.At ?? "";
            var naming = DocumentSpans.Read(texts[file]).StringsAt(copy.FormKey, copy.FieldPaths)
                .Where(found => found.Value.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (naming.Count < copy.FieldPaths.Count)
            {
                leftBehind.Add($"{Named(copy)}: its plugin source does not name {name} at {string.Join(", ", copy.FieldPaths)}");
                continue;
            }
            spans[file] = [.. spans.GetValueOrDefault(file) ?? [], .. naming.Select(found => (found.Start, found.End))];
            if (!plugins.Contains(copy.Plugin, PluginAddress.Comparer)) plugins.Add(copy.Plugin);
        }
        var spelled = JsonSerializer.Serialize(newName)[1..^1];
        return new(
            [.. spans.Select(file => new DocumentChange(file.Key, Spliced(texts[file.Key], file.Value, spelled)))],
            plugins,
            [.. copies.Where(copy => copy.Place == ScriptCopyPlace.NoPluginSource).Select(Named), .. unread, .. leftBehind]);
    }

    // Reads the copy's file into texts, once per file.
    private string? WhyLeftBehind(ScriptCopyFile copy, Dictionary<string, string> texts)
    {
        switch (copy.Place)
        {
            case ScriptCopyPlace.NoCopy: return $"{copy.Plugin.Name} ({copy.Plugin.Origin}) holds no {copy.FormKey}.";
            case ScriptCopyPlace.Rendered: return $"{Named(copy)}: its plugin source holds no file of it";
            case ScriptCopyPlace.Unread: return copy.At ?? $"{Named(copy)}: the record index cannot say where it sits";
        }
        var file = copy.At ?? "";
        if (texts.ContainsKey(file)) return null;
        try
        {
            texts[file] = _source.TextAt(file);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return $"{Named(copy)}: {ex.Message}";
        }
    }

    private static string Named(ScriptCopyFile copy) => $"{copy.FormKey} in {copy.Plugin.Name} ({copy.Plugin.Origin})";

    private static string Spliced(string text, List<(int Start, int End)> spans, string spelled) =>
        spans.OrderByDescending(span => span.Start).Aggregate(text, (after, span) => after[..span.Start] + spelled + after[span.End..]);
}
