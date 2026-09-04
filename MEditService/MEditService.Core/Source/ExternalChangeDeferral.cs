using System.Text.Json;

namespace MEditService.Core.Source;

/// <summary>Until an external-change question is answered, the plugin is refused for editing.
/// Per-plugin, never per-repo: a mod folder can hold several plugins whose dialogs answer
/// independently. Same marker-file idiom as <see cref="CompileJournal"/>.</summary>
public static class ExternalChangeDeferral
{
    private const string MarkerFileName = "MEDIT_EXTERNAL_CHANGE";

    private static string MarkerPath(string modFolder) => Path.Combine(modFolder, ".git", MarkerFileName);

    /// <summary><paramref name="question"/> is the exact user-facing message a refused edit gets back, so
    /// the signposting names the real unanswered question rather than a generic "try again later".</summary>
    public static void Set(string modFolder, string plugin, string question)
    {
        var entries = ReadAll(modFolder);
        entries[plugin] = question;
        WriteAll(modFolder, entries);
    }

    /// <summary>Deletes the marker file once no plugin in this repo has an unanswered question left:
    /// marker present means something is unanswered, absent means clean.</summary>
    public static void Clear(string modFolder, string plugin)
    {
        var entries = ReadAll(modFolder);
        if (!entries.Remove(plugin)) return;

        if (entries.Count == 0)
        {
            var path = MarkerPath(modFolder);
            if (File.Exists(path)) File.Delete(path);
        }
        else
        {
            WriteAll(modFolder, entries);
        }
    }

    /// <summary>The unanswered question's message, or null — never a throw for an untracked folder or a
    /// missing marker.</summary>
    public static string? Unanswered(string modFolder, string plugin)
    {
        var entries = ReadAll(modFolder);
        return entries.TryGetValue(plugin, out var question) ? question : null;
    }

    private static Dictionary<string, string> ReadAll(string modFolder)
    {
        var path = MarkerPath(modFolder);
        if (!File.Exists(path)) return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in doc.RootElement.GetProperty("plugins").EnumerateObject())
            result[property.Name] = property.Value.GetString() ?? "";
        return result;
    }

    private static void WriteAll(string modFolder, Dictionary<string, string> entries)
    {
        var gitDir = Path.Combine(modFolder, ".git");
        if (!Directory.Exists(gitDir)) return; // repo vanished since Set was called — nothing to persist to.

        var json = JsonSerializer.Serialize(new { plugins = entries });
        var path = MarkerPath(modFolder);

        // Same write-then-rename discipline as CompileJournal's own marker.
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, json);
        File.Move(tempPath, path, overwrite: true);
    }
}
