using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

/// <summary>A Partial Form override's own fields, even ones that genuinely differ from the master,
/// must not register as a conflict (CONTEXT.md: "its own fields are ignored... full stop").</summary>
public sealed class PartialFormCompareTests
{
    private const int PartialFormBit = 0x0000_4000;
    private const float MasterWaterHeight = 100f;
    // Deliberately different from the master's own value — proves the override's field is excluded
    // from conflict detection because it is Partial Form, not merely because the values happen to
    // agree.
    private const float OverrideOwnWaterHeight = 999f;
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
        overrideCell.WaterHeight = OverrideOwnWaterHeight;
        var refr = new PlacedObject(overrideMod) { EditorID = "TestRef", Scale = 1f };
        overrideCell.Temporary.Add(refr);
        _refKey = refr.FormKey;

        var rows = new[]
        {
            new FakeRow(BasePlugin, 0, IsWinner: false, RealDocuments.Of(baseCell, BasePlugin, 0, isWinner: false, Release, "cell", ["WaterHeight"])),
            new FakeRow(OverridePlugin, 1, IsWinner: true, RealDocuments.Of(overrideCell, OverridePlugin, 1, isWinner: true, Release, "cell", ["WaterHeight"])),
            new FakeRow(OverridePlugin, 1, IsWinner: true, RealDocuments.Of(refr, OverridePlugin, 1, isWinner: true, Release, "refr", [])),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, Masters: [], RecordCount: 1),
            [OverridePlugin] = new(IsLight: false, IsMaster: false, Masters: ["Base.esm"], RecordCount: 2),
        };
        var plugins = new[]
        {
            new RegisteredPlugin("Base.esm", "Data", "Base.esm", 0, Enabled: true, Winning: true),
            new RegisteredPlugin("Partial.esp", "Data", "Partial.esp", 1, Enabled: true, Winning: true),
        };
        var holder = FakeLoadOrder.Of(Release, plugins);
        _service = new RecordQueryService(new FakeIndex(new FakeReads(opened, rows)), holder, SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    // ── IsPartialForm threads through the read model ────────────────────────────────────────

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

    // ── Cell shows no conflict; REFR shows normally ─────────────────────────────────────────

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

    // ── Per-field WinnerColumn falls through past a Partial Form override ────────────────────

    [Fact]
    public void GetCompare_CellWithPartialFormOverride_WaterHeightWinnerFallsThroughToMaster()
    {
        // The record-wide winner is Partial.esp, but its own water_height is excluded: the field's
        // effective value is the master's, and WinnerColumn must say so rather than name an excluded
        // column.
        var compare = _service.GetCompare(_cellKey.ToString());
        Assert.NotNull(compare);
        var waterHeight = compare.Diffs.Single(d => d.FieldName == "WaterHeight");

        Assert.Equal("Base.esm", waterHeight.WinnerColumn);
        Assert.Equal(MasterWaterHeight, Assert.IsType<System.Text.Json.JsonElement>(waterHeight.Values["Base.esm"]).GetSingle());
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
