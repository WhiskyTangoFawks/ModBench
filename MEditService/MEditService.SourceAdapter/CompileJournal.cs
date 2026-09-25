using System.Text.Json;

namespace MEditService.SourceAdapter;

/// <summary>compile-plugin, steps 5 and 7: the mark that a compile has begun, so an interrupted one
/// is never read as another program's change. A marker file inside <c>.git</c>, one per repo, naming
/// every plugin of the mod whose compile began and has not landed since.</summary>
public static class CompileJournal
{
    private const string MarkerFileName = "MEDIT_COMPILE_JOURNAL";

    private static string MarkerPath(string modFolder) => Path.Combine(modFolder, ".git", MarkerFileName);

    /// <summary>Marks <paramref name="plugin"/> before <paramref name="compile"/> runs, and clears it
    /// once it lands. <paramref name="compile"/> answers false for a refusal that wrote nothing, which
    /// puts the mark back as it was; a throw leaves the plugin marked.</summary>
    public static async Task<bool> RunAsync(string modFolder, string plugin, Func<Task<bool>> compile)
    {
        var earlier = UnfinishedBatch(modFolder);
        var named = (earlier?.Plugins ?? []).Union([plugin], StringComparer.Ordinal).ToList();
        var landedBefore = (earlier?.Landed ?? []).Where(p => !string.Equals(p, plugin, StringComparison.Ordinal)).ToList();
        WriteMarker(modFolder, new CompileJournalState(named, landedBefore));

        if (!await compile())
        {
            Settle(modFolder, earlier);
            return false;
        }

        Settle(modFolder, new CompileJournalState(named, [.. landedBefore, plugin]));
        return true;
    }

    // A mark with nothing unlanded is deleted, so its file exists only while it means something.
    private static void Settle(string modFolder, CompileJournalState? state)
    {
        if (state is null || state.Unlanded.Count == 0) File.Delete(MarkerPath(modFolder));
        else WriteMarker(modFolder, state);
    }

    /// <summary>The marker's content, or null when no plugin it names is unlanded: a marker means the
    /// disk/parked-ref mismatch is Modbench's own interrupted compile, not an external change. A marker
    /// whose every plugin landed is one a crash kept from being deleted, and means nothing.</summary>
    public static CompileJournalState? UnfinishedBatch(string modFolder)
    {
        var path = MarkerPath(modFolder);
        if (!File.Exists(path)) return null;

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var plugins = ReadStringArray(doc.RootElement, "plugins");
        var landed = ReadStringArray(doc.RootElement, "landed");
        var state = new CompileJournalState(plugins, landed);
        return state.Unlanded.Count == 0 ? null : state;
    }

    private static List<string> ReadStringArray(JsonElement root, string propertyName) =>
        root.GetProperty(propertyName).EnumerateArray()
            .Select(e => e.GetString() ?? throw new InvalidOperationException(
                $"Expected every '{propertyName}' element to be a non-null string."))
            .ToList();

    private static void WriteMarker(string modFolder, CompileJournalState state)
    {
        var json = JsonSerializer.Serialize(new { plugins = state.Plugins, landed = state.Landed });
        var path = MarkerPath(modFolder);

        // Write-then-rename: a marker torn by a second crash mid-write would defeat the point of having one.
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, json);
        File.Move(tempPath, path, overwrite: true);
    }
}

/// <summary>A journal marker's content: every plugin whose compile began since the mark was left, and
/// which of them have landed since. <see cref="Unlanded"/> is the plugins whose binary may be bad.</summary>
public sealed record CompileJournalState(IReadOnlyList<string> Plugins, IReadOnlyList<string> Landed)
{
    public IReadOnlyList<string> Unlanded => [.. Plugins.Except(Landed, StringComparer.Ordinal)];
}
