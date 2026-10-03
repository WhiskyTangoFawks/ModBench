using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class PartialFormCompareTests
{
    private const int PartialFormBit = 0x0000_4000;
    private const float MasterWaterHeight = 100f;
    private const float OverrideOwnWaterHeightDifferingSoTheExclusionIsPartialFormsNotAgreement = 999f;
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress OverridePlugin = new("Partial.esp", "Data");

    private readonly FormKey _cellKey;
    private readonly FormKey _refKey;
    private readonly RecordQueryService _service;

    public PartialFormCompareTests()
    {
        var baseMod = new Fallout4Mod(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
        var baseCell = new Cell(baseMod) { EditorID = "TestCell", WaterHeight = MasterWaterHeight };
        _cellKey = baseCell.FormKey;

        var overrideMod = new Fallout4Mod(ModKey.FromFileName("Partial.esp"), Fallout4Release.Fallout4);
        var overrideCell = baseCell.DeepCopy();
        overrideCell.MajorRecordFlagsRaw |= PartialFormBit;
        overrideCell.WaterHeight = OverrideOwnWaterHeightDifferingSoTheExclusionIsPartialFormsNotAgreement;
        var refr = new PlacedObject(overrideMod) { EditorID = "TestRef", Scale = 1f };
        overrideCell.Temporary.Add(refr);
        _refKey = refr.FormKey;

        var rows = new[]
        {
            new FakeRow(BasePlugin, 0, IsWinner: false, RealDocuments.Of(baseCell, BasePlugin, 0, isWinner: false, Release, "cell", ["EditorID", "WaterHeight"])),
            new FakeRow(OverridePlugin, 1, IsWinner: true, RealDocuments.Of(overrideCell, OverridePlugin, 1, isWinner: true, Release, "cell", ["EditorID", "WaterHeight"])),
            new FakeRow(OverridePlugin, 1, IsWinner: true, RealDocuments.Of(refr, OverridePlugin, 1, isWinner: true, Release, "refr", [])),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 1, IsMedium: false),
            [OverridePlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: ["Base.esm"], RecordCount: 2, IsMedium: false),
        };
        var plugins = new[]
        {
            new LoadOrderEntry("Base.esm", "Base.esm", "Data", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Partial.esp", "Partial.esp", "Data", 1, Enabled: true, Winning: true),
        };
        var holder = FakeLoadOrder.Of(Release, plugins);
        _service = new RecordQueryService(new FakeIndex(new FakeReads(opened, rows)), holder, SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    [Fact]
    public void GetCompare_MasterOverride_IsPartialFormFalse()
    {
        var compare = _service.GetCompare(_cellKey.ToString());
        Assert.NotNull(compare);
        var master = compare.Overrides.Single(o => o.Plugin == "Base.esm");

        Assert.False(master.IsPartialForm);
    }

    [Fact]
    public void GetCompare_PartialFormOverride_IsPartialFormTrue()
    {
        var compare = _service.GetCompare(_cellKey.ToString());
        Assert.NotNull(compare);
        var partial = compare.Overrides.Single(o => o.Plugin == "Partial.esp");

        Assert.True(partial.IsPartialForm);
    }

    [Fact]
    public void GetCompare_CellWithPartialFormOverride_ShowsNoConflict()
    {
        var compare = _service.GetCompare(_cellKey.ToString());

        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_CellWithPartialFormOverride_WaterHeightDiffCarriesNoCellStateForTheOverride()
    {
        var compare = _service.GetCompare(_cellKey.ToString());
        Assert.NotNull(compare);
        var waterHeight = compare.Diffs.Single(d => d.FieldName == "WaterHeight");

        Assert.Equal(ConflictAll.NoConflict, waterHeight.ConflictAll);
        Assert.DoesNotContain("Partial.esp", waterHeight.CellStates.Keys);
    }

    [Fact]
    public void GetCompare_CellWithPartialFormOverride_WaterHeightWinnerFallsThroughToMaster_NotTheExcludedRecordWideWinnerPartialEsp()
    {
        var compare = _service.GetCompare(_cellKey.ToString());
        Assert.NotNull(compare);
        var waterHeight = compare.Diffs.Single(d => d.FieldName == "WaterHeight");

        Assert.Equal("Base.esm", waterHeight.WinnerColumn);
        Assert.Equal(MasterWaterHeight, Assert.IsType<System.Text.Json.JsonElement>(waterHeight.Values["Base.esm"]).GetSingle());
    }

    [Fact]
    public void GetCompare_PartialFormOverride_KeepsItsEditorIDInTheComparison_AsItsOwnFieldsAreNot()
    {
        var compare = _service.GetCompare(_cellKey.ToString());
        Assert.NotNull(compare);
        var editorId = compare.Diffs.Single(d => d.FieldName == "EditorID");

        Assert.Equal(ConflictThis.IdenticalToMaster, editorId.CellStates["Partial.esp"]);
        Assert.Equal("TestCell", Assert.IsType<System.Text.Json.JsonElement>(editorId.Values["Partial.esp"]).GetString());
    }

    [Fact]
    public void GetRecord_RefIntroducedByPartialFormOverride_ShowsNormally()
    {
        var compare = _service.GetCompare(_refKey.ToString());

        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        Assert.Single(compare.Overrides);
        Assert.Equal("Partial.esp", compare.Overrides[0].Plugin);
    }
}
