using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.Query;

public sealed class VersionStampConflictTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress OverridePlugin = new("Over.esp", "Data");
    private static readonly string[] Members = ["VersionControl", "FormVersion", "MajorRecordFlagsRaw", "WaterHeight"];

    private readonly RecordQueryService _service;
    private readonly FormKey _cellKey;

    public VersionStampConflictTests()
    {
        var baseMod = new Fallout4Mod(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
        var baseCell = new Cell(baseMod) { EditorID = "TestCell", WaterHeight = 100f, VersionControl = 1, FormVersion = 131 };
        _cellKey = baseCell.FormKey;
        var overrideCell = baseCell.DeepCopy();
        overrideCell.VersionControl = 2;
        overrideCell.FormVersion = 132;
        overrideCell.WaterHeight = 200f;

        var rows = new[]
        {
            new FakeRow(BasePlugin, 0, IsWinner: false, RealDocuments.Of(baseCell, BasePlugin, 0, isWinner: false, Release, "cell", Members)),
            new FakeRow(OverridePlugin, 1, IsWinner: true, RealDocuments.Of(overrideCell, OverridePlugin, 1, isWinner: true, Release, "cell", Members)),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 1),
            [OverridePlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: ["Base.esm"], RecordCount: 1),
        };
        var plugins = new[]
        {
            new LoadOrderEntry("Base.esm", "Base.esm", "Data", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Over.esp", "Over.esp", "Data", 1, Enabled: true, Winning: true),
        };
        _service = new RecordQueryService(
            new FakeIndex(new FakeReads(opened, rows)), FakeLoadOrder.Of(Release, plugins), SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private CompareResult Compare()
    {
        var compare = _service.GetCompare(_cellKey.ToString());
        Assert.NotNull(compare);
        return compare;
    }

    [Theory]
    [InlineData("VersionControl")]
    [InlineData("FormVersion")]
    public void GetCompare_DifferingVersionStamp_ShowsNoConflict(string stamp)
    {
        var diff = Compare().Diffs.Single(d => d.FieldName == stamp);

        Assert.Equal(ConflictAll.NoConflict, diff.ConflictAll);
        Assert.Empty(diff.CellStates);
    }

    [Fact]
    public void GetCompare_DifferingVersionStampsAlone_LeaveTheRecordWithItsOtherFieldsConflict()
    {
        var compare = Compare();

        Assert.Equal(ConflictAll.Override, compare.Diffs.Single(d => d.FieldName == "WaterHeight").ConflictAll);
        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
    }
}
