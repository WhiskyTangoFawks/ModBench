using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.TestSupport;

/// <summary>A real tracked mod folder with an index over it, holding flat records only: for the
/// suites that are the Index side. A write-side suite takes <see cref="Edits.SourceEditFixture"/>
/// instead.</summary>
public sealed class IndexedModFixture : IDisposable
{
    public const string ModFolderOrigin = "FixtureMod";
    public const string PluginName = "Fixture.esp";

    // The MO2 instance this mod folder lives in (ADR-0001), also the fixture's cleanup root.
    public string InstanceRoot { get; }

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public IndexProjector Index { get; }
    public PluginKey Plugin { get; }

    // PluginName unless a caller asked otherwise: ref-unsafe names need a real tracked load order.
    public string ActualPluginName { get; }

    // Keyword is a valid target for the NPC's keywords field and Race a resolvable target of the
    // wrong type, so both FormLink error axes are reachable without inventing data mid-test.
    public FormKey Npc { get; }
    public FormKey Race { get; }
    public FormKey Keyword { get; }
    public FormKey OtherNpc { get; }

    private IndexedModFixture(
        bool track, string pluginName, bool isLight = false, bool persistent = false,
        INotificationPublisher? notifications = null)
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

        Index = new IndexProjector(
            new DuckDbRecordIndexFactory(
                SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance), notifications));
        Index.Reconcile(
            GameDirectory,
            [Entry],
            GameRelease.Fallout4,
            persistent ? InstanceRoot : null);

        if (track)
        {
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(Index, ModFolderOrigin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }
    }

    public static IndexedModFixture Tracked() => new(track: true, PluginName);

    /// <summary>Tracked, with every projection the index publishes recorded: what a watcher's signal
    /// reaches the front end as (ADR-0046).</summary>
    public static IndexedModFixture Tracked(INotificationPublisher notifications) =>
        new(track: true, PluginName, notifications: notifications);

    /// <summary>Tracked, over a persistent index file keyed on <see cref="InstanceRoot"/>, so a second
    /// Index over the same instance starts warm — the shape a restart has.</summary>
    public static IndexedModFixture TrackedPersistent() => new(track: true, PluginName, persistent: true);

    /// <summary>The load order snapshot this fixture's one plugin copy is, for a caller reconciling a
    /// second Index over the same instance.</summary>
    public LoadOrderEntry Entry =>
        new(ActualPluginName, Path.Combine(ModFolder, ActualPluginName), ModFolderOrigin, Slot: 0, Enabled: true, Winning: true);

    public static IndexedModFixture TrackedLight(string pluginName = PluginName) =>
        new(track: true, pluginName, isLight: true);

    public static IndexedModFixture Untracked() => new(track: false, PluginName);

    public static IndexedModFixture TrackedAs(string pluginName) => new(track: true, pluginName);

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

    // Unavoidable, not defensive: plain porcelain v1 C-quotes any path containing a space
    // unconditionally — core.quotePath governs only bytes above 0x80 — and these names all have one.
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
        Path.GetRelativePath(ModFolder, SourceDocumentPath.Of(
            ModFolder, ActualPluginName, recordType, formKey.ToString(), editorId, GameRelease.Fallout4));

    public void Dispose()
    {
        Index.Dispose();
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
