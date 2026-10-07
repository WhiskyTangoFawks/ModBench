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
    private static readonly string[] Members = ["VersionControl", "FormVersion", "Version2", "MajorRecordFlagsRaw", "WaterHeight"];

    [Theory]
    [InlineData("VersionControl")]
    [InlineData("FormVersion")]
    [InlineData("Version2")]
    public void GetCompare_DifferingVersionStamp_ShowsNoConflict(string stamp)
    {
        var (service, key) = Compare(WithDifferingStamps);

        var diff = Diffs(service, key).Single(d => d.FieldName == stamp);

        Assert.Equal(ConflictAll.NoConflict, diff.ConflictAll);
        Assert.Empty(diff.CellStates);
        Assert.Equal(2, diff.Values.Count(v => v.Value != null));
    }

    [Fact]
    public void GetCompare_CopiesDifferingInTheVersionStampsAlone_ShowNoConflictOnTheRecordOrThePlugin()
    {
        var (service, key) = Compare(WithDifferingStamps);

        var compare = service.GetCompare(key);

        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
        Assert.Equal(ConflictThis.IdenticalToMaster, compare.Overrides.Single(o => o.Plugin == "Over.esp").ConflictThis);
    }

    [Fact]
    public void GetCompare_CopiesDifferingInTheVersionStampsAndAnotherField_ConflictOnThatFieldAlone()
    {
        var (service, key) = Compare(cell =>
        {
            WithDifferingStamps(cell);
            cell.WaterHeight = 200f;
        });

        var compare = service.GetCompare(key);

        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
        Assert.Equal(ConflictThis.Override, compare.Overrides.Single(o => o.Plugin == "Over.esp").ConflictThis);
    }

    private static void WithDifferingStamps(Cell cell)
    {
        cell.VersionControl = 2;
        cell.FormVersion = 121;
        cell.Version2 = 3;
    }

    private static IReadOnlyList<FieldDiff> Diffs(IRecordQueryService service, string key)
    {
        var compare = service.GetCompare(key);
        Assert.NotNull(compare);
        return compare.Diffs;
    }

    private static (IRecordQueryService Service, string Key) Compare(Action<Cell> overrideEdit)
    {
        var baseMod = new Fallout4Mod(ModKey.FromFileName("Base.esm"), Fallout4Release.Fallout4);
        var baseCell = new Cell(baseMod) { EditorID = "TestCell", WaterHeight = 100f, VersionControl = 1, FormVersion = 120, Version2 = 1 };
        var overrideCell = baseCell.DeepCopy();
        overrideEdit(overrideCell);

        var rows = new[]
        {
            new FakeRow(BasePlugin, 0, IsWinner: false, RealDocuments.Of(baseCell, BasePlugin, 0, isWinner: false, Release, "cell", Members)),
            new FakeRow(OverridePlugin, 1, IsWinner: true, RealDocuments.Of(overrideCell, OverridePlugin, 1, isWinner: true, Release, "cell", Members)),
        };
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 1, IsMedium: false),
            [OverridePlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: ["Base.esm"], RecordCount: 1, IsMedium: false),
        };
        var plugins = new[]
        {
            new LoadOrderEntry("Base.esm", "Base.esm", "Data", 0, Enabled: true, Winning: true),
            new LoadOrderEntry("Over.esp", "Over.esp", "Data", 1, Enabled: true, Winning: true),
        };
        var service = QueryHost.Records(
            new FakeIndex(new FakeReads(opened, rows)), FakeLoadOrder.Of(Release, plugins));
        return (service, baseCell.FormKey.ToString());
    }
}
