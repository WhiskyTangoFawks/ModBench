using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
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
    private static SessionManager MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory);
    }

    /// <summary>Writes another physical copy of <paramref name="name"/> into its own folder, with
    /// one NPC carrying <paramref name="editorId"/>. Built from the same ModKey as the fixture's
    /// copy, so the two files agree on the record's FormKey and differ only in its EditorID — which
    /// is what makes "did the index come from the other file?" a single-field question.</summary>
    private static string WriteCopy(string root, string folder, string name, string editorId, int extraRecords = 0)
    {
        var dir = Path.Combine(root, folder);
        Directory.CreateDirectory(dir);
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        // Each AddNew consumes a FormID, so `extraRecords` is how a copy is given a NextFormID
        // demonstrably different from the fixture's — see the reservation test below.
        for (var i = 0; i < extraRecords; i++) mod.Npcs.AddNew($"{editorId}Filler{i}");
        var path = Path.Combine(dir, name);
        mod.WriteToBinary(path);
        return path;
    }

    // #421: reads through the seam (Search) rather than raw SQL against .Connection — the interface
    // no longer exposes one (invariant 8). RecordSummary already carries all three fields this once
    // read positionally off the npc_ table.
    private static (string Origin, string EditorId, bool IsWinner) ReadIndexedNpc(SessionManager manager, string plugin)
    {
        var result = manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey(plugin), Limit: 10, Offset: 0));
        var row = Assert.Single(result.Items);
        return (row.Origin, row.EditorId!, row.IsWinner);
    }

    [Fact]
    public void RereadPlugin_FromANewOrigin_SessionReportsTheNewOriginAndPath()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-meta")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB");

        var manager = MakeManager();
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

        var manager = MakeManager();
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
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var gate = new GatedIndexRepositoryFactory(inner, gateBefore: "B.esp");
        using var manager = new SessionManager(gate);
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

    /// <summary>Fires <paramref name="onUnindex"/> the first time a re-read unindexes the copy it
    /// is replacing — i.e. from *inside* the mutation, which is the only place a test can get a
    /// thread in edgeways while <see cref="SessionManager.RereadPlugin"/> holds the session lock.
    /// Nothing on the load path calls Unindex, so the hook cannot fire early.</summary>
    private sealed class UnindexHookFactory(IRecordIndexFactory inner, Action onUnindex) : IRecordIndexFactory
    {
        public IRecordIndex Create(GameRelease gameRelease) => new HookedRepository(inner.Create(gameRelease), onUnindex);

        private sealed class HookedRepository(IRecordIndex inner, Action onUnindex) : DelegatingRecordIndex(inner)
        {
            private bool _fired;
            public override void Unindex(PluginKey key)
            {
                if (!_fired) { _fired = true; onUnindex(); }
                base.Unindex(key);
            }
        }
    }

    // #279 review: the re-read holds the session for the whole of its mutation, so a teardown
    // cannot land midway and dispose the DuckDB connection it is still writing to — the crash class
    // MEditService/CLAUDE.md's drain invariant exists to prevent.
    //
    // Unload() is the teardown, deliberately rather than a competing Load: it disposes the session
    // *without* ever setting _loadCancellation, so the in-flight-load check cannot see it coming.
    // Only the lock's scope can refuse it, which makes this a test of that scope rather than of the
    // check.
    //
    // Honest limit: this cannot fail on the exact split-lock version the review found. There the
    // mutation was still a single lock block and the unguarded window sat between the check and
    // RequirePlugin, with no injectable seam inside it to park a thread in. What it does pin is
    // that the mutation may never *again* be narrowed out of that lock — the same defect
    // reintroduced from the other end.
    [Fact]
    public async Task RereadPlugin_HoldsTheSessionAcrossItsMutation_SoATeardownCannotLandMidway()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-teardown")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB");

        var reflector = SharedSchemaReflector.Instance;
        SessionManager? manager = null;
        Task? teardown = null;
        var factory = new UnindexHookFactory(
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)),
            () =>
            {
                var started = new ManualResetEventSlim();
                teardown = Task.Run(() => { started.Set(); manager!.Unload(); });
                Assert.True(started.Wait(TimeSpan.FromSeconds(5)), "the teardown thread never started");
                // If the re-read did not hold the session across its mutation, this is exactly
                // where the disposal would land — part-way through unindex/index/sweep.
                Assert.False(
                    teardown.Wait(TimeSpan.FromMilliseconds(250)),
                    "Unload completed while a re-read was mid-mutation — the session can be disposed underneath it");
            });

        manager = new SessionManager(factory);
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            var response = sessionManager.RereadPlugin("A.esp", newPath, "ModB");

            // It ran to completion against a live session, not a half-disposed one.
            Assert.Equal("ModB", response.Origin);
            // Awaited, not blocked on (xUnit1031); the timeout keeps a genuine deadlock a failure
            // rather than a hung suite.
            await teardown!.WaitAsync(TimeSpan.FromSeconds(30));
            // And the teardown it held off then happened, rather than being lost.
            Assert.Null(manager.Session);
        }
    }

    // #279 review (Suite axis): the FormID reservation counter belongs to the *file*, not the name.
    // Carrying the replaced copy's counter over would hand out FormKeys the new copy has already
    // used — silent data corruption at the next Create Record. The negation on that line survived
    // mutation, i.e. nothing observed it; this is what observes it.
    [Fact]
    public void RereadPlugin_ReservesTheNextFormIdOfTheCopyItReadFromDisk()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-formid")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        // Two more records than the loaded copy, so the two files' NextFormIDs cannot coincide and
        // the reserved key names which file the counter came from.
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB", extraRecords: 2);

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);
            var beforeReread = sessionManager.ReserveFormKey("A.esp");

            sessionManager.RereadPlugin("A.esp", newPath, "ModB");

            var afterReread = sessionManager.ReserveFormKey("A.esp");
            // Not merely "different": specifically the new copy's own next id, which is three
            // FormIDs further on than the one-record copy the session loaded. A counter left
            // untouched would answer one past `beforeReread` instead.
            Assert.NotEqual(beforeReread, afterReread);
            var used = FormKey.Factory(beforeReread).ID;
            Assert.Equal(used + 2, FormKey.Factory(afterReread).ID);
        }
    }

    // #279 review (Suite axis): the endpoint's own blank check filters before SessionManager is
    // ever called, so these two guards had no coverage at all. Tested here directly, matching the
    // CreatePlugin_NullName/_WhitespaceName pair this method is patterned after — each public entry
    // point answers for its own arguments, independently of the API layer in front of it.
    [Fact]
    public void RereadPlugin_BlankPath_ThrowsArgumentException()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-blank-path")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            var ex = Assert.Throws<ArgumentException>(() => sessionManager.RereadPlugin("A.esp", "   ", "ModB"));
            Assert.Contains("path", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void RereadPlugin_BlankOrigin_ThrowsArgumentException()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-blank-origin")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "A.esp", "FromModB");

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            // A real path, so "no origin" is the only thing left for this to be refused over.
            var ex = Assert.Throws<ArgumentException>(() => sessionManager.RereadPlugin("A.esp", newPath, "   "));
            Assert.Contains("origin", ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public void RereadPlugin_PluginTheSessionDoesNotHold_Throws()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-unknown")
            .WithPlugin("A.esp", mod => mod.Npcs.AddNew("FromModA"), origin: "ModA")
            .BuildScattered();
        var newPath = WriteCopy(fx.Root, "mod-ModB", "Absent.esp", "Whatever");

        var manager = MakeManager();
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

        var manager = MakeManager();
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

        var manager = MakeManager();
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
