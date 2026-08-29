using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Query;

// #544: fixture-verifies GetPluginDelta — the Stack node's "Compare with winner" bulk seam.
// Reuses the exact two-mod-same-filename rig FileOverrideCompareColumnTests (#446) already
// established, with explicit FormKeys (rather than AddNew's coincidental sequencing) so each of
// the four cases below lands at a chosen, non-colliding local ID.
public sealed class PluginDeltaTests
{
    private static readonly ModKey SharedKey = ModKey.FromFileName("Shared.esp");

    // Local IDs, one per case, deliberately never reused across the two copies so each case is
    // independent of the others.
    private const uint IdenticalId = 0x800;   // both copies define it, same content -> must be ABSENT from the delta
    private const uint DiffersId = 0x801;     // both copies define it, different content -> BothDiffer
    private const uint WinnerOnlyId = 0x802;  // only the winner copy defines it -> WinnerOnly
    private const uint PeerOnlyId = 0x803;    // only the peer copy defines it -> PeerOnly

    [Fact]
    public void GetPluginDelta_TwoCopiesOfSameFilename_ReportsOnlyDifferencesWithPresence()
    {
        var fx = new PluginFixtureBuilder("plugin-delta-544")
            .WithPlugin("Shared.esp", mod =>
            {
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, IdenticalId), Fallout4Release.Fallout4) { EditorID = "Identical", Name = "SameName" });
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, DiffersId), Fallout4Release.Fallout4) { EditorID = "Differs", Name = "NameFromWinner" });
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, WinnerOnlyId), Fallout4Release.Fallout4) { EditorID = "WinnerOnly", Name = "OnlyInWinner" });
            }, origin: "ModA")
            .WithPlugin("Shared.esp", mod =>
            {
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, IdenticalId), Fallout4Release.Fallout4) { EditorID = "Identical", Name = "SameName" });
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, DiffersId), Fallout4Release.Fallout4) { EditorID = "Differs", Name = "NameFromPeer" });
                mod.Npcs.Add(new Npc(new FormKey(SharedKey, PeerOnlyId), Fallout4Release.Fallout4) { EditorID = "PeerOnly", Name = "OnlyInPeer" });
            }, origin: "ModB")
            .BuildScattered();
        using var _ = fx;

        using var manager = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        var winner = fx.Plugins.Where(p => p.Origin != "ModB").ToList();
        var peer = fx.Plugins.Single(p => p.Origin == "ModB");
        manager.LoadExplicit(fx.GameDirectory, winner, GameRelease.Fallout4);
        manager.LoadUnlistedPlugin(peer.Path, peer.Origin);

        var svc = new RecordQueryService(manager, SharedSchemaReflector.Instance, new ConflictClassifier());

        var delta = svc.GetPluginDelta("Shared.esp", winnerOrigin: "ModA", peerOrigin: "ModB");
        Assert.NotNull(delta);
        var byEditorId = delta.ToDictionary(e => e.EditorId!, e => e.Presence);

        // The rival this kills: "render every shared FormKey, greyed if identical" would include
        // "Identical" in the output (flagged some other way) rather than omitting it outright.
        Assert.DoesNotContain("Identical", byEditorId.Keys);

        Assert.Equal(3, delta.Count);
        Assert.Equal(PluginDeltaPresence.WinnerOnly, byEditorId["WinnerOnly"]);
        Assert.Equal(PluginDeltaPresence.PeerOnly, byEditorId["PeerOnly"]);
        Assert.Equal(PluginDeltaPresence.BothDiffer, byEditorId["Differs"]);
    }

    [Fact]
    public void GetPluginDelta_PeerNoLongerLoaded_ReturnsNull()
    {
        // #544: the vanished-peer race — a Stack peer collapsed (unloaded, #448) between the
        // context-menu click and this call reaching the backend. Search alone can't tell "this
        // origin has zero records" apart from "this origin doesn't exist" — this test pins the
        // distinction: null, not an empty list computed as if every winner record were a
        // one-sided difference.
        var fx = new PluginFixtureBuilder("plugin-delta-544-vanished")
            .WithPlugin("Shared.esp", mod => mod.Npcs.Add(
                new Npc(new FormKey(SharedKey, WinnerOnlyId), Fallout4Release.Fallout4) { EditorID = "Whatever" }), origin: "ModA")
            .BuildScattered();
        using var _ = fx;

        using var manager = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        manager.LoadExplicit(fx.GameDirectory, fx.Plugins, GameRelease.Fallout4);

        var svc = new RecordQueryService(manager, SharedSchemaReflector.Instance, new ConflictClassifier());

        Assert.Null(svc.GetPluginDelta("Shared.esp", winnerOrigin: "ModA", peerOrigin: "ModB"));
    }
}
