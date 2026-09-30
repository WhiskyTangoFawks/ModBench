using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.Query;

// ADR-0012: the compare grid is xEdit parity, the record's in-game resolution stack. An overridden
// plugin is a file the game never loads, so it is not a column, though it stays indexed and
// browsable.
public sealed class FileOverrideCompareColumnTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private static RecordQueryService Service(IReadOnlyList<LoadOrderEntry> plugins, IReadOnlyList<FakeRow> rows)
    {
        var opened = plugins.ToDictionary(
            c => new PluginAddress(c.Name, c.Origin), _ => new PluginContent(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: [], RecordCount: 1));
        var holder = FakeLoadOrder.Of(Release, [.. plugins]);
        return new(new FakeIndex(new FakeReads(opened, rows)), holder, SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private static FakeRow Row(string plugin, string origin, int loadOrderIndex, bool isWinner, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(plugin), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew(editorId);
        var key = new PluginAddress(plugin, origin);
        return new(key, loadOrderIndex, isWinner, RealDocuments.Of(npc, key, loadOrderIndex, isWinner, Release, "npc_", []));
    }

    // A record of another plugin's, overridden in this one.
    private static FakeRow OverrideRow(string plugin, string origin, FormKey of, int loadOrderIndex, bool isWinner, string editorId)
    {
        var npc = new Npc(of, Fallout4Release.Fallout4) { EditorID = editorId };
        var key = new PluginAddress(plugin, origin);
        return new(key, loadOrderIndex, isWinner, RealDocuments.Of(npc, key, loadOrderIndex, isWinner, Release, "npc_", []));
    }

    [Fact]
    public void GetCompare_TwoOriginsProvideSameFilename_ExcludesTheOverriddenPluginsColumn()
    {
        // Both plugins land on the identical nominal FormKey (000800) because each Fallout4Mod runs
        // its own NextFormID sequence from the same ModKey, so this is a same-identity comparison.
        var plugins = new[]
        {
            new LoadOrderEntry("Shared.esp", "Shared.esp", "ModA", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Shared.esp", "Shared.esp", "ModB", 0, Enabled: true, Winning: false),
        };
        var rows = new[]
        {
            Row("Shared.esp", "ModA", 0, isWinner: true, "FromModA"),
            Row("Shared.esp", "ModB", 0, isWinner: false, "FromModB"),
        };
        var svc = Service(plugins, rows);

        var compare = svc.GetCompare("000800:Shared.esp");

        Assert.NotNull(compare);
        // xEdit parity: the game loads exactly one file named Shared.esp, so the grid shows
        // exactly one column — the winning plugin's own record, not the discarded file's.
        var column = Assert.Single(compare.Overrides);
        Assert.Equal("ModA", column.Origin);
        Assert.Equal("FromModA", column.EditorId);
        Assert.True(column.IsWinner);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
    }

    // ADR-0012 invariant 5: a plugin that is not active is not a compare-grid column, whatever the
    // reason the game does not load it.
    [Fact]
    public void GetCompare_APluginWhoseLineIsDisabled_IsNoColumn()
    {
        var plugins = new[]
        {
            new LoadOrderEntry("Base.esm", "Base.esm", "ModA", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Solo.esp", "Solo.esp", "ModB", 1, Enabled: false, Winning: true),
        };
        var baseRow = Row("Base.esm", "ModA", 0, isWinner: true, "FromBase");
        var rows = new[] { baseRow, OverrideRow("Solo.esp", "ModB", FormKey.Factory(baseRow.Document.FormKey), 1, isWinner: false, "FromSolo") };
        var svc = Service(plugins, rows);

        var compare = svc.GetCompare(baseRow.Document.FormKey);

        Assert.NotNull(compare);
        Assert.Equal("FromBase", Assert.Single(compare.Overrides).EditorId);
    }
}
