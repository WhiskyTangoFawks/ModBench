using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.Query;

// ADR-0012: the compare grid is xEdit parity, the record's in-game resolution stack. A file-level
// loser is a file the game never loads, so it is not a column, though it stays indexed and
// browsable.
public sealed class FileOverrideCompareColumnTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private static RecordQueryService Service(IReadOnlyList<RegisteredPlugin> copies, IReadOnlyList<FakeRow> rows)
    {
        var opened = copies.ToDictionary(
            c => new PluginAddress(c.Name, c.Origin), _ => new PluginContent(IsLight: false, IsMaster: false, Masters: [], RecordCount: 1));
        var holder = FakeLoadOrder.Of(Release, [.. copies]);
        return new(new FakeIndex(new FakeReads(opened, rows)), holder, SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private static FakeRow Row(string plugin, string origin, int loadOrderIndex, bool isWinner, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(plugin), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew(editorId);
        var key = new PluginAddress(plugin, origin);
        return new(key, loadOrderIndex, isWinner, RealDocuments.Of(npc, key, loadOrderIndex, isWinner, Release, "npc_", []));
    }

    [Fact]
    public void GetCompare_TwoOriginsProvideSameFilename_ExcludesTheFileLevelLosersColumn()
    {
        // Both copies land on the identical nominal FormKey (000800) because each Fallout4Mod runs
        // its own NextFormID sequence from the same ModKey, so this is a same-identity comparison.
        var copies = new[]
        {
            new RegisteredPlugin("Shared.esp", "ModA", "Shared.esp", 0, Enabled: true, Winning: true),
            new RegisteredPlugin("Shared.esp", "ModB", "Shared.esp", 0, Enabled: true, Winning: false),
        };
        var rows = new[]
        {
            Row("Shared.esp", "ModA", 0, isWinner: true, "FromModA"),
            Row("Shared.esp", "ModB", 0, isWinner: false, "FromModB"),
        };
        var svc = Service(copies, rows);

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
        // The deliberately-untouched axis: a disabled line is not a file-level loser, since its file
        // is the one the name resolves to and the user merely switched it off. Only Winning filters,
        // so the exclusion never widens to Participates.
        var copies = new[] { new RegisteredPlugin("Solo.esp", "ModA", "Solo.esp", 0, Enabled: false, Winning: true) };
        var rows = new[] { Row("Solo.esp", "ModA", 0, isWinner: true, "FromSolo") };
        var svc = Service(copies, rows);

        var compare = svc.GetCompare("000800:Solo.esp");

        Assert.NotNull(compare);
        var column = Assert.Single(compare.Overrides);
        Assert.Equal("FromSolo", column.EditorId);
    }
}
