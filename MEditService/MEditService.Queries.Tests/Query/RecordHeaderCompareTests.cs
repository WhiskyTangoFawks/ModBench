using System.Text.Json;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class RecordHeaderCompareTests
{
    private const int PartialFormBit = 0x0000_4000;
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress OverridePlugin = new("Partial.esp", "Data");

    private static (FormKey Cell, IRecordQueryService Service) PartialFormOverride()
    {
        var baseMod = new Fallout4Mod(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
        var baseCell = new Cell(baseMod) { EditorID = "TestCell", WaterHeight = 100f };
        var overrideCell = baseCell.DeepCopy();
        overrideCell.MajorRecordFlagsRaw |= PartialFormBit;
        overrideCell.WaterHeight = 999f;

        var rows = new[]
        {
            new FakeRow(RealDocuments.Of(baseCell, BasePlugin, 0, Release)),
            new FakeRow(RealDocuments.Of(overrideCell, OverridePlugin, 1, Release)),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 1, IsMedium: false),
            [OverridePlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: ["Base.esm"], RecordCount: 1, IsMedium: false),
        };
        var holder = FakeLoadOrder.Of(Release,
            new LoadOrderEntry("Base.esm", "Base.esm", "Data", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Partial.esp", "Partial.esp", "Data", 1, Enabled: true, Winning: true));
        return (baseCell.FormKey,
            QueryHost.Records(new FakeIndex(new FakeReads(opened, rows)), holder));
    }

    private static Dictionary<string, FieldDiff> Diffs(IRecordQueryService service, FormKey cell) =>
        (service.GetCompare(cell.ToString()) ?? throw new InvalidOperationException("Expected the cell to compare."))
            .Diffs.ToDictionary(d => d.FieldName, StringComparer.Ordinal);

    [Fact]
    public void APartialFormCopysHeaderMembers_TakePart_WhereItsOwnFieldsDoNot()
    {
        var (cell, service) = PartialFormOverride();
        var diffs = Diffs(service, cell);

        var flags = diffs["MajorRecordFlagsRaw"];
        Assert.Equal(PartialFormBit, Assert.IsType<JsonElement>(flags.Values["Partial.esp"]).GetInt32());
        Assert.Equal(ConflictThis.Override, flags.CellStates["Partial.esp"]);
        Assert.Null(diffs["WaterHeight"].Values["Partial.esp"]);
    }

    [Fact]
    public void AHeaderMemberNoCopySpells_StillHasItsRow()
    {
        var (cell, service) = PartialFormOverride();

        var version2 = Diffs(service, cell)["Version2"];

        Assert.Equal(2, version2.Values.Count);
        Assert.All(version2.Values.Values, Assert.Null);
    }
}
