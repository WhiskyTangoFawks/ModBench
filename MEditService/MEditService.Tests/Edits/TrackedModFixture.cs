using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #415: a real mod folder, holding a real plugin, loaded into a real session and tracked through
/// the real <see cref="TrackService"/> — the state every edit-path test starts from, because the
/// thing under test is what an edit does to a git working tree, and there is no honest way to ask
/// that of a mock. Same posture as #414's own repo-layer tests (real git, real CLI).
///
/// Deliberately tiny: three records is enough for "the edited one changed and the others did not",
/// which is all any test here needs from the fixture's size.
/// </summary>
public sealed class TrackedModFixture : IDisposable
{
    public const string ModFolderOrigin = "FixtureMod";
    public const string PluginName = "Fixture.esp";

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public SessionManager Sessions { get; }
    public PluginKey Plugin { get; } = new(PluginName, ModFolderOrigin);

    /// <summary>The NPC every editing test edits, and the two records that must stay untouched
    /// beside it (one of them the NPC's own Race, so a FormLink target is always on hand).</summary>
    public FormKey Npc { get; }
    public FormKey Race { get; }
    public FormKey OtherNpc { get; }

    private TrackedModFixture(bool track)
    {
        ModFolder = Directory.CreateTempSubdirectory("medit-edit-mod-").FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-edit-game-").FullName;

        var pluginPath = Path.Combine(ModFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        var otherNpc = mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(pluginPath);
        (Npc, Race, OtherNpc) = (npc.FormKey, race.FormKey, otherNpc.FormKey);

        Sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)Sessions).LoadExplicit(
            GameDirectory,
            [new ExplicitPluginInput(PluginName, pluginPath, ModFolderOrigin, true)],
            GameRelease.Fallout4);

        if (track)
        {
            new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance)
                .TrackAsync(Sessions.Session!, ModFolderOrigin, LedgerPreset.Edits)
                .GetAwaiter().GetResult();
        }
    }

    public static TrackedModFixture Tracked() => new(track: true);

    /// <summary>The same mod folder with no <c>.git</c> in it — tracking *is* the presence of that
    /// directory (ADR-0041), so this is the whole of "untracked".</summary>
    public static TrackedModFixture Untracked() => new(track: false);

    public string LedgerFileFor(FormKey formKey, string recordType) =>
        Path.Combine(ModFolder, LedgerRecordPath.For(PluginName, recordType, formKey.ToString()));

    public string NpcLedgerFile => LedgerFileFor(Npc, "npc_");

    /// <summary>Porcelain status, scoped to the mod folder — what the native Source Control panel
    /// renders, asked the way a user would ask it.</summary>
    public IReadOnlyList<string> GitStatus() =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

    public string GitShowHead(string relativePath) =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "show", $"HEAD:{relativePath.Replace('\\', '/')}");

    public static string RelativeLedgerPath(FormKey formKey, string recordType) =>
        LedgerRecordPath.For(PluginName, recordType, formKey.ToString());

    public void Dispose()
    {
        Sessions.Dispose();
        TryDelete(ModFolder);
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
