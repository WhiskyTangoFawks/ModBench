using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Session;

/// <summary>
/// #356: a re-read that resolves a plugin name onto a newly-tracked origin must follow that
/// origin's own source tree, exactly as an ordinary session load already does for any tracked
/// plugin (<c>SessionManager.IndexOnePlugin</c> / <c>SourceIngest.TreeFor</c>) — never the binary
/// beside it. Nothing migrates and nothing is lost either way: a tracked mod's edits live in its
/// own git repository, independent of whichever copy a re-read happens to read.
///
/// <see cref="TrackedModFixture"/> tracks a mod folder through the real <c>TrackService</c>, so its
/// source tree is genuine (Spriggit-shaped, git-committed) rather than a hand-built stand-in.
/// The working tree is then hand-edited exactly the way a real text editor or agent would
/// (<c>ReadTimeFreshnessTests</c>' own pattern) — this is what distinguishes "read the source tree"
/// from "read the binary beside it", which still carries the pre-Track content Track committed.
/// </summary>
public sealed class SessionManagerRereadPluginTrackedOriginTests
{
    private static SessionManager MakeManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new SessionManager(factory);
    }

    // Filtered to one FormKey rather than Assert.Single over every npc_ row: TrackedModFixture's
    // plugin always carries two NPCs (Npc and OtherNpc, #415's own "the edited one changed and the
    // others did not" shape), so an unfiltered read is never single-valued once the session holds
    // the tracked copy.
    private static (string Origin, string EditorId) ReadIndexedNpc(SessionManager manager, string plugin, FormKey formKey)
    {
        var result = manager.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: new PluginKey(plugin), Limit: 10, Offset: 0));
        var row = result.Items.Single(r => r.FormKey == formKey.ToString());
        return (row.Origin, row.EditorId!);
    }

    [Fact]
    public void RereadPlugin_OntoATrackedOrigin_IngestsFromItsSourceTree_NotTheBinaryBesideIt()
    {
        using var fx = new PluginFixtureBuilder("sm-reread-tracked")
            .WithPlugin("Fixture.esp", mod => mod.Npcs.AddNew("FromOldMod"), origin: "OldMod")
            .BuildScattered();
        using var tracked = TrackedModFixture.TrackedAs("Fixture.esp");

        // A hand edit to the tracked working tree, never compiled back to the binary — the binary at
        // tracked.ModFolder still reads "FixtureNpc", the content Track committed.
        var text = File.ReadAllText(tracked.NpcSourceFile);
        File.WriteAllText(tracked.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"FromTrackedSource\"", StringComparison.Ordinal));

        var manager = MakeManager();
        using (manager)
        {
            ISessionManager sessionManager = manager;
            sessionManager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

            var newPath = Path.Combine(tracked.ModFolder, "Fixture.esp");
            sessionManager.RereadPlugin("Fixture.esp", newPath, TrackedModFixture.ModFolderOrigin);

            var (origin, editorId) = ReadIndexedNpc(manager, "Fixture.esp", tracked.Npc);
            Assert.Equal(TrackedModFixture.ModFolderOrigin, origin);
            // The source tree's hand-edited content, not the binary's pre-Track "FixtureNpc" —
            // the same fact IndexOnePlugin's own doc comment states as the destination for every
            // ingestion path, reread included.
            Assert.Equal("FromTrackedSource", editorId);
        }
    }
}
