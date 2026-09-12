using System.Text.Json;

namespace MEditService.SourceRepo;

/// <summary>Journals a compile batch so a crash cannot leave it silently half-done; a single plugin's
/// binary write is already atomic. A marker file inside <c>.git</c>, one per repo — a batch is one
/// mod folder.</summary>
public static class CompileJournal
{
    private const string MarkerFileName = "MEDIT_COMPILE_JOURNAL";

    private static string MarkerPath(string modFolder) => Path.Combine(modFolder, ".git", MarkerFileName);

    /// <summary>The marker is written before the first compile, rewritten after each landed plugin, and
    /// deleted only once every plugin has landed. A refusal stops the batch and leaves the rest
    /// unlanded — deliberately indistinguishable from a crash.</summary>
    public static IReadOnlyList<string> RunBatch(
        string modFolder, IReadOnlyList<string> plugins, Func<string, bool> compileOne)
    {
        if (plugins.Count == 0) return [];

        WriteMarker(modFolder, plugins, landed: []);

        var landed = new List<string>();
        foreach (var plugin in plugins)
        {
            if (!compileOne(plugin)) break;

            landed.Add(plugin);
            WriteMarker(modFolder, plugins, landed);
        }

        if (landed.Count == plugins.Count)
            File.Delete(MarkerPath(modFolder));

        return landed;
    }

    /// <summary>The marker's content, or null when the last batch completed cleanly: a marker means the
    /// disk/parked-ref mismatch is Modbench's own interrupted compile, not an external change.</summary>
    public static CompileJournalState? UnfinishedBatch(string modFolder)
    {
        var path = MarkerPath(modFolder);
        if (!File.Exists(path)) return null;

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var plugins = ReadStringArray(doc.RootElement, "plugins");
        var landed = ReadStringArray(doc.RootElement, "landed");
        return new CompileJournalState(plugins, landed);
    }

    private static List<string> ReadStringArray(JsonElement root, string propertyName) =>
        root.GetProperty(propertyName).EnumerateArray().Select(e => e.GetString()!).ToList();

    private static void WriteMarker(string modFolder, IReadOnlyList<string> plugins, IReadOnlyList<string> landed)
    {
        var json = JsonSerializer.Serialize(new { plugins, landed });
        var path = MarkerPath(modFolder);

        // Write-then-rename: a marker torn by a second crash mid-write would defeat the point of having one.
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, json);
        File.Move(tempPath, path, overwrite: true);
    }
}

/// <summary>A journal marker's content: every plugin the interrupted batch named, and which of them
/// had already landed. <see cref="Unlanded"/> is everything the batch didn't reach — recovery's own
/// job, never this record's.</summary>
public sealed record CompileJournalState(IReadOnlyList<string> Plugins, IReadOnlyList<string> Landed)
{
    public IReadOnlyList<string> Unlanded => [.. Plugins.Except(Landed, StringComparer.Ordinal)];
}
