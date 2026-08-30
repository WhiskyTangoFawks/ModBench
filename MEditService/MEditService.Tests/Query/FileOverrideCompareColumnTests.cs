using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Query;

// #446: fixture-verifies the *file-level* resolution-stack case (CONTEXT.md "Resolution stack") —
// two mod folders providing the same plugin filename, exactly ADR-0036's "shadowed copies": "MO2
// priority picks one and the other is discarded before the load order is built" — through the
// GetCompare/read-model seam #446 names, distinct from the record-level (within-load-order)
// shadowing #304 exercised (which has no backend footprint at all: #304 is entirely
// PluginHeader/RecordPanel/DiffRow/extendedFieldEditor rendering).
//
// This is deliberately *not* a duplicate of DuplicateFilenameLoadOrderApiTests
// (ShadowedCopyLoadedOnDemand_IsItsOwnCompareColumn), which already builds the identical two-mod
// fixture and proves the same claim — but does so as a full HTTP round trip through the API host.
// This test calls RecordQueryService.GetCompare directly, in-process, which is the narrower seam
// #446's own wording ("the GetCompare/read-model seam") asks for and the one that would fail first
// if a regression landed inside GetCompare's own annotation step rather than in JSON translation.
public sealed class FileOverrideCompareColumnTests
{
    [Fact]
    public void GetCompare_TwoModsProvideSameFilename_ProducesOneColumnPerOrigin()
    {
        // ModA is the load-order winner (what MO2's file-conflict merge picked); ModB is the file
        // it discarded — the losing copy, registered beside the winner (ADR-0044). Both copies run
        // their own NextFormID sequence from the same ModKey, so both NPCs land on the identical
        // nominal FormKey ("000800:Shared.esp") — the same coincidence DuplicateFilenameLoadOrderApiTests
        // relies on, and what makes this a same-identity delta comparison rather than two unrelated files.
        var fx = new PluginFixtureBuilder("file-override-446")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA").Name = "NameFromModA", origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB").Name = "NameFromModB", origin: "ModB")
            .BuildScattered();
        using var _ = fx;

        using var manager = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        // ADR-0044: the snapshot carries both copies — plugins.txt names the filename once, so
        // both share its slot, and only ModA is the copy the Mod override order resolves it to.
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var snapshot = fx.Plugins
            .Select(p => p.Origin == "ModB" ? p with { Slot = winner.Slot, Winning = false } : p)
            .ToList();
        manager.Reconcile(fx.GameDirectory, snapshot, GameRelease.Fallout4);

        var svc = new RecordQueryService(manager, SharedSchemaReflector.Instance, new ConflictClassifier());

        var compare = svc.GetCompare("000800:Shared.esp");

        Assert.NotNull(compare);
        var byOrigin = compare.Overrides.ToDictionary(o => o.Origin, o => o);
        Assert.Equal(2, compare.Overrides.Count);
        Assert.Equal("FromModA", byOrigin["ModA"].EditorId);
        Assert.Equal("FromModB", byOrigin["ModB"].EditorId);
        Assert.True(byOrigin["ModA"].IsWinner);
        Assert.False(byOrigin["ModB"].IsWinner);
        // #267 / ADR-0035: the shadowed copy never participates, so this stays exactly as
        // unconflicted as a single-origin record — not a new conflict between the two copies.
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
    }
}
