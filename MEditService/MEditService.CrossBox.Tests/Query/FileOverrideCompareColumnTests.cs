using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Queries;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Query;

// ADR-0012: the compare grid is xEdit parity, the record's in-game resolution stack. A file-level
// loser is a file the game never loads, so it is not a column, though it stays indexed and
// browsable.
public sealed class FileOverrideCompareColumnTests
{
    [Fact]
    public void GetCompare_TwoOriginsProvideSameFilename_ExcludesTheFileLevelLosersColumn()
    {
        var holder = new LoadOrderHolder();
        // Both copies run their own NextFormID sequence from the same ModKey, so both NPCs land on the
        // identical nominal FormKey, which is what makes this a same-identity comparison rather than two
        // unrelated files.
        var fx = new PluginFixtureBuilder("file-override-446")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModA").Name = "NameFromModA", origin: "ModA")
            .WithPlugin("Shared.esp", mod => mod.Npcs.AddNew("FromModB").Name = "NameFromModB", origin: "ModB")
            .BuildScattered();
        using var _ = fx;

        using var manager = Indexes.Open(holder);
        // ADR-0013: the snapshot carries both copies — plugins.txt names the filename once, so
        // both share its slot, and only ModA is the copy the Mod override order resolves it to.
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var snapshot = fx.Plugins
            .Select(p => p.Origin == "ModB" ? p with { Slot = winner.Slot, Winning = false } : p)
            .ToList();
        manager.Reconcile(holder, fx.GameDirectory, snapshot, GameRelease.Fallout4);

        var svc = new RecordQueryService(manager, holder, SharedSchemaReflector.Instance, new ConflictClassifier());

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
        var holder = new LoadOrderHolder();
        // The deliberately-untouched axis: a disabled line is not a file-level loser, since its file is the
        // one the name resolves to and the user merely switched it off. Only Winning filters, so the
        // exclusion never widens to Participates.
        var fx = new PluginFixtureBuilder("file-override-446-disabled")
            .WithPlugin("Solo.esp", mod => mod.Npcs.AddNew("FromSolo").Name = "NameFromSolo", origin: "ModA")
            .BuildScattered();
        using var _ = fx;

        using var manager = Indexes.Open(holder);
        var snapshot = fx.Plugins.Select(p => p with { Enabled = false }).ToList();
        manager.Reconcile(holder, fx.GameDirectory, snapshot, GameRelease.Fallout4);

        var svc = new RecordQueryService(manager, holder, SharedSchemaReflector.Instance, new ConflictClassifier());

        var compare = svc.GetCompare("000800:Solo.esp");

        Assert.NotNull(compare);
        var column = Assert.Single(compare.Overrides);
        Assert.Equal("FromSolo", column.EditorId);
    }
}
