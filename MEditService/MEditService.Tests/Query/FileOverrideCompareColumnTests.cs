using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Query;

// Fixture-verifies the *file-level* resolution-stack case (CONTEXT.md "Resolution stack") —
// two mod folders providing the same plugin filename, exactly ADR-0036's "shadowed copies": "MO2
// priority picks one and the other is discarded before the load order is built" — through the
// GetCompare/read-model seam.
//
// ADR-0036 (amended, #618 follow-up): the compare grid is xEdit parity — the record's in-game
// resolution stack. A file-level loser is a file the game never loads, so it is *not* a column;
// it stays indexed and browsable from the plugins tree, and a future toggle may re-expose it.
// The exclusion is Registration.Winning alone — a disabled or unlisted copy is a different,
// deliberately untouched axis (it still columns; see the plugins-tree display ticket).
public sealed class FileOverrideCompareColumnTests
{
    [Fact]
    public void GetCompare_TwoOriginsProvideSameFilename_ExcludesTheFileLevelLosersColumn()
    {
        // ModA is the load-order winner (what MO2's file-conflict merge picked); ModB is the file
        // it discarded — the losing copy, registered beside the winner (ADR-0044). Both copies run
        // their own NextFormID sequence from the same ModKey, so both NPCs land on the identical
        // nominal FormKey ("000800:Shared.esp") — the same coincidence DuplicateFilenameLoadOrderApiTests
        // relies on, and what makes this a same-identity comparison rather than two unrelated files.
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
        // xEdit parity: the game loads exactly one file named Shared.esp, so the grid shows
        // exactly one column — the winning copy's own record, not the discarded file's.
        var column = Assert.Single(compare.Overrides);
        Assert.Equal("ModA", column.Origin);
        Assert.Equal("FromModA", column.EditorId);
        Assert.True(column.IsWinner);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_DisabledButWinningCopy_StillColumns()
    {
        // The deliberately-untouched axis: a disabled line (Enabled false, Winning true) is not a
        // file-level loser — its file is the one the name resolves to; the user merely switched it
        // off. It stays a column exactly as before the #618 follow-up; only Winning filters.
        // This is the guard that the exclusion never widens to Participates.
        var fx = new PluginFixtureBuilder("file-override-446-disabled")
            .WithPlugin("Solo.esp", mod => mod.Npcs.AddNew("FromSolo").Name = "NameFromSolo", origin: "ModA")
            .BuildScattered();
        using var _ = fx;

        using var manager = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        var snapshot = fx.Plugins.Select(p => p with { Enabled = false }).ToList();
        manager.Reconcile(fx.GameDirectory, snapshot, GameRelease.Fallout4);

        var svc = new RecordQueryService(manager, SharedSchemaReflector.Instance, new ConflictClassifier());

        var compare = svc.GetCompare("000800:Solo.esp");

        Assert.NotNull(compare);
        var column = Assert.Single(compare.Overrides);
        Assert.Equal("FromSolo", column.EditorId);
    }
}
