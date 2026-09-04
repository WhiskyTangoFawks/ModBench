using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A real mod folder tracked through the real <see cref="TrackService"/>: what an edit
/// does to a git working tree is the thing under test, and no mock can answer that.</summary>
public sealed class TrackedModFixture : IDisposable
{
    public const string ModFolderOrigin = "FixtureMod";
    public const string PluginName = "Fixture.esp";

    // The MO2 instance this mod folder lives in (ADR-0001), also the fixture's cleanup root.
    public string InstanceRoot { get; }

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public LoadOrderMirror Mirror { get; }
    public PluginKey Plugin { get; }

    // PluginName unless a caller asked otherwise: ref-unsafe names need a real tracked load order.
    public string ActualPluginName { get; }

    // Keyword is a valid target for the NPC's keywords field and Race a resolvable target of the
    // wrong type, so both FormLink error axes are reachable without inventing data mid-test.
    public FormKey Npc { get; }
    public FormKey Race { get; }
    public FormKey Keyword { get; }
    public FormKey OtherNpc { get; }

    private TrackedModFixture(bool track, string pluginName, bool isLight = false)
    {
        ActualPluginName = pluginName;
        Plugin = new PluginKey(pluginName, ModFolderOrigin);
        InstanceRoot = Directory.CreateTempSubdirectory("medit-edit-instance-").FullName;
        ModFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "mods", ModFolderOrigin)).FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-edit-game-").FullName;

        var pluginPath = Path.Combine(ModFolder, pluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        mod.IsSmallMaster = isLight;
        var race = mod.Races.AddNew("FixtureRace");
        var keyword = mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        var otherNpc = mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(pluginPath);
        (Npc, Race, Keyword, OtherNpc) = (npc.FormKey, race.FormKey, keyword.FormKey, otherNpc.FormKey);

        Mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)Mirror).Reconcile(
            GameDirectory,
            [new LoadOrderEntry(pluginName, pluginPath, ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        if (track)
        {
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(Mirror.LoadOrder!, ModFolderOrigin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }
    }

    public static TrackedModFixture Tracked() => new(track: true, PluginName);

    public static TrackedModFixture TrackedLight(string pluginName = PluginName) =>
        new(track: true, pluginName, isLight: true);

    public static TrackedModFixture Untracked() => new(track: false, PluginName);

    public static TrackedModFixture TrackedAs(string pluginName) => new(track: true, pluginName);

    public const string NpcEditorId = "FixtureNpc";
    public const string RaceEditorId = "FixtureRace";
    public const string KeywordEditorId = "FixtureKeyword";
    public const string OtherNpcEditorId = "UntouchedNpc";

    // editorId is a parameter rather than looked up internally: Spriggit's flat file name embeds it,
    // and an edit-created record's EditorID is one this fixture never saw.
    public string SourceFileFor(FormKey formKey, string recordType, string? editorId) =>
        Path.Combine(ModFolder, RelativeSourcePath(formKey, recordType, editorId));

    public string NpcSourceFile => SourceFileFor(Npc, "npc_", NpcEditorId);

    public IReadOnlyList<string> GitStatus() =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => UnquotePorcelainLine(l.Trim()))
            .ToList();

    // "XY <path>": <path> is C-quoted exactly when it needs to be. Track sets core.quotePath=false,
    // so only \\ and \" can arise here, but this is written generally rather than special-cased.
    private static string UnquotePorcelainLine(string line)
    {
        var space = line.IndexOf(' ');
        if (space < 0) return line;
        var status = line[..space];
        var rest = line[(space + 1)..].TrimStart();
        if (rest.Length < 2 || rest[0] != '"' || rest[^1] != '"') return line;

        var inner = rest[1..^1];
        var unquoted = new System.Text.StringBuilder(inner.Length);
        for (var i = 0; i < inner.Length; i++)
        {
            if (inner[i] != '\\' || i + 1 >= inner.Length) { unquoted.Append(inner[i]); continue; }
            var next = inner[++i];
            unquoted.Append(next switch
            {
                '"' => '"',
                '\\' => '\\',
                't' => '\t',
                'n' => '\n',
                _ => next,
            });
        }
        return $"{status} {unquoted}";
    }

    public string GitShowHead(string relativePath) =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "show", $"HEAD:{relativePath.Replace('\\', '/')}");

    public string RelativeSourcePath(FormKey formKey, string recordType, string? editorId) =>
        Path.GetRelativePath(ModFolder, SourceUnitResolver.FlatSourcePath(
            ModFolder, ActualPluginName, recordType, formKey.ToString(), editorId, GameRelease.Fallout4));

    public void Dispose()
    {
        Mirror.Dispose();
        TryDelete(InstanceRoot);
        TryDelete(GameDirectory);
    }

    // A tracked mod folder holds a .git tree whose object files are read-only on some filesystems,
    // and a test failing on cleanup would mask the real assertion that already ran.
    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
