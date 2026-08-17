using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Session;

// #279 / ADR-0035 § Live mutation: a mod-level change can make a plugin name resolve to a
// different physical file while the session is open. Nothing re-reads it automatically — the row
// is flagged, and this is the explicit per-plugin re-read the user can then ask for. The caller
// (Mod Management, which owns mods/ and the file-conflict merge) supplies the new path and origin,
// exactly as it does for LoadUnlistedPlugin: the session cannot resolve a filename to a mod folder
// and must never try.
public sealed class SessionManagerRereadPluginTests
{
    private static (SessionManager Manager, DuckDbPendingChangeService Changes) MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        return (manager, changes);
    }

    /// <summary>Writes another physical copy of <paramref name="name"/> into its own folder, with
    /// one NPC carrying <paramref name="editorId"/>. Built from the same ModKey as the fixture's
    /// copy, so the two files agree on the record's FormKey and differ only in its EditorID — which
    /// is what makes "did the index come from the other file?" a single-field question.</summary>
    private static string WriteCopy(string root, string folder, string name, string editorId)
    {
        var dir = Path.Combine(root, folder);
        Directory.CreateDirectory(dir);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        var path = Path.Combine(dir, name);
        mod.WriteToBinary(path);
        return path;
    }

    private static (string Origin, string EditorId, bool IsWinner) ReadIndexedNpc(SessionManager manager, string plugin)
    {
        var repository = (IRecordRepository)manager.Repository!;
        using var cmd = repository.Connection.CreateCommand();
        cmd.CommandText = "SELECT origin, editor_id, is_winner FROM npc_ WHERE plugin = $1";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        using var reader = cmd.ExecuteReader();
        Assert.True(reader.Read(), $"expected exactly one indexed npc_ row for {plugin}");
        var row = (reader.GetString(0), reader.GetString(1), reader.GetBoolean(2));
        Assert.False(reader.Read(), $"expected exactly one indexed npc_ row for {plugin}, found more");
        return row;
    }

    [Fact]
    public void RereadPlugin_FromANewOrigin_SessionReportsTheNewOriginAndPath()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-meta")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB");

        var (manager, _) = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            sessionManager.RereadPlugin("A.esp", newPath, "ModB");

            var plugin = manager.Session!.Plugins.Single(p => p.Name == "A.esp");
            Assert.Equal("ModB", plugin.Origin);
            Assert.Equal(newPath, plugin.Path);
        }
    }

    [Fact]
    public void RereadPlugin_FromANewOrigin_IndexHoldsTheNewFileAndNothingFromTheOld()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-index")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB");

        var (manager, _) = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
            Assert.Equal("FromModA", ReadIndexedNpc(manager, "A.esp").EditorId);

            sessionManager.RereadPlugin("A.esp", newPath, "ModB");

            // One row, not two: the old copy's rows are unindexed rather than left alongside the
            // new ones under a stale origin (ReadIndexedNpc asserts the count).
            var (origin, editorId, isWinner) = ReadIndexedNpc(manager, "A.esp");
            Assert.Equal("ModB", origin);
            Assert.Equal("FromModB", editorId);
            // AC7: winners are re-swept, so conflict state describes the new file. Index() writes
            // every row is_winner=false and only UpdateWinners() can flip it, so this is false
            // unless the sweep actually ran.
            Assert.True(isWinner);
        }
    }

    // The consequence the re-read confirm has to state before it happens (#279 AC6). Discarded
    // rather than migrated or left alone: pending_changes is keyed on (form_key, origin, plugin)
    // and reads overlay by origin, so a change left behind is invisible but still live — and
    // SavePlugin resolves its write target by *filename*, so it would later be written into the
    // new copy's file, having been authored against bytes that are gone. That is the silent-
    // wrong-state tier of ADR-0026; discarding is the only honest option, which is why the user is
    // told first.
    [Fact]
    public void RereadPlugin_DiscardsStagedEditsAgainstTheCopyItReplaces()
    {
        FormKey npcKey = default;
        using var fx = new PluginFixtureBuilder("sm-reread-staged")
            .WithPlugin("A.esp", mod => npcKey = mod.Npcs.AddNew("FromModA").FormKey, origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB");

        var (manager, changes) = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
            changes.Upsert(new PendingChangeUpsert(
                npcKey.ToString(), "A.esp", "Npc",
                new Dictionary<string, JsonElement> { ["aggression"] = JsonDocument.Parse("\"Frenzied\"").RootElement.Clone() },
                "user", null,
                new Dictionary<string, JsonElement> { ["aggression"] = JsonDocument.Parse("\"Unaggressive\"").RootElement.Clone() },
                null, "field_edit", null, null, "ModA"));
            Assert.NotEmpty(changes.GetChanges("A.esp"));

            sessionManager.RereadPlugin("A.esp", newPath, "ModB");

            Assert.Empty(changes.GetChanges("A.esp"));
        }
    }

    // A re-read that arrives mid-load is refused, not queued and above all not run: the indexing
    // loop is writing to the very repository it would unindex from, and taking the exclusive right
    // (EnterExclusive) would *cancel* the load the user is watching. The endpoint maps this to 409,
    // the same "nothing went wrong, ask again" answer the session-load contract already gives.
    [Fact]
    public async Task RereadPlugin_WhileALoadIsInFlight_IsRefusedWithoutDisturbingTheLoad()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-busy")
            .WithPlugin("Fallout4.esm")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .WithPlugin("B.esp", mod => mod.Npcs.AddNew("FromB"))
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB");

        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        using var gate = new GatedIndexRepositoryFactory(inner, gateBefore: "B.esp");
        using var manager = new SessionManager(gate, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        ISessionManager sessionManager = manager;

        var load = Task.Run(() => sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4));
        await gate.WaitUntilParkedAsync();

        // Parked mid-load with A.esp already indexed — so the re-read has a real target and is
        // refused for being mid-load, not for having nothing to act on.
        Assert.Throws<SessionBusyException>(() => sessionManager.RereadPlugin("A.esp", newPath, "ModB"));

        gate.Release();
        await load;

        // The load finished on its own terms and still holds the copy it was loading.
        Assert.Equal("ModA", manager.Session!.Plugins.Single(p => p.Name == "A.esp").Origin);
        Assert.Equal("FromModA", ReadIndexedNpc(manager, "A.esp").EditorId);
    }

    [Fact]
    public void RereadPlugin_PluginTheSessionDoesNotHold_Throws()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-unknown")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "Absent.esp", "Whatever");

        var (manager, _) = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            Assert.Throws<KeyNotFoundException>(() => sessionManager.RereadPlugin("Absent.esp", newPath, "ModB"));
        }
    }

    [Fact]
    public void RereadPlugin_NoSession_Throws()
    {
        // A real file, so "no session" is the only thing left for this to be refused over — the
        // path check (which mirrors LoadUnlistedPlugin's, and runs first) would otherwise answer
        // for it and the test would pass without ever reaching the session gate.
        using var fx = new PluginFixtureBuilder("sm-reread-nosession")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();

        var (manager, _) = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            Assert.Throws<InvalidOperationException>(
                () => sessionManager.RereadPlugin("A.esp", fx.Plugins.Single(p => p.Name == "A.esp").Path, "ModB"));
        }
    }

    [Fact]
    public void RereadPlugin_FileThatIsNotThere_ThrowsAndLeavesTheLoadedCopyIntact()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-missing")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();

        var (manager, _) = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            Assert.Throws<FileNotFoundException>(
                () => sessionManager.RereadPlugin("A.esp", Path.Combine(fx.Root, "gone", "A.esp"), "ModB"));

            // Refused before anything was touched: the session still serves the copy it loaded,
            // rather than being left holding neither.
            var plugin = manager.Session!.Plugins.Single(p => p.Name == "A.esp");
            Assert.Equal("ModA", plugin.Origin);
            Assert.Equal("FromModA", ReadIndexedNpc(manager, "A.esp").EditorId);
        }
    }
}
