using System.Text.Json;

namespace MEditService.Core.Source;

/// <summary>
/// #417 exit path 3: "Until answered, the affected plugin is refused for editing... Deferral is
/// per-plugin, not per-session." — set the moment detection queues a question (never only on an
/// explicit Esc: Esc's own contribution is that nothing further gets written, but the plugin is
/// already refused from the instant it was detected, by <c>Bridge.ExternalChangeWatcher.
/// ReportExternalChange</c>, the one shared choke point both the live watcher and the load-time
/// hash check queue a question through). Same marker-file idiom as <see cref="CompileJournal"/> — a
/// plain file inside the repo's own <c>.git</c>, not a registry — but keyed per <b>plugin</b>, not
/// per repo, and a mod folder can hold more than one plugin whose dialogs answer independently.
///
/// <para>This is the one place both doors #415 pinned onto the single write path consult before
/// writing anything: <see cref="Edits.RecordEditService.EditField"/> checks <see cref="Unanswered"/>
/// before touching the source file or the index, so every edit gesture that goes through it — today
/// and whatever #426/#427 add later — inherits the refusal without adding its own check.</para>
///
/// <para>Public (not internal) since #417: <c>MEditService.Bridge</c> is the one place that writes
/// this marker (<c>ExternalChangeWatcher.ReportExternalChange</c>) and cannot see Core's internals —
/// the same "promote once a second real consumer exists" rule <c>ModFolders</c>/<c>SourceRecordType</c>
/// already followed.</para>
/// </summary>
public static class ExternalChangeDeferral
{
    private const string MarkerFileName = "MEDIT_EXTERNAL_CHANGE";

    private static string MarkerPath(string modFolder) => Path.Combine(modFolder, ".git", MarkerFileName);

    /// <summary>Records that <paramref name="plugin"/> has an unanswered external-change question —
    /// <paramref name="question"/> is the exact user-facing message <see cref="Unanswered"/> hands back
    /// to a refused edit, so the signposting names the real unanswered question rather than a generic
    /// "try again later".</summary>
    public static void Set(string modFolder, string plugin, string question)
    {
        var entries = ReadAll(modFolder);
        entries[plugin] = question;
        WriteAll(modFolder, entries);
    }

    /// <summary>Answers the question for <paramref name="plugin"/> — called once Absorb Upstream
    /// Update or Keep as My Edit has landed. Deletes the marker file entirely once no plugin in this
    /// repo has a unanswered question left, the same "marker present means something is unanswered, absent
    /// means clean" idiom <see cref="CompileJournal"/> uses.</summary>
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

    /// <summary>The unanswered question's message, or null when <paramref name="plugin"/> has none —
    /// safe to call for an untracked folder or one with no marker at all, never a throw (same
    /// degrade-don't-crash posture as every other read in this folder).</summary>
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
