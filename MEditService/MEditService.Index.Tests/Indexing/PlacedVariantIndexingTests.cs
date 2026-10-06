using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Indexing;

public sealed class PlacedVariantIndexingTests : IDisposable
{
    private static readonly PluginAddress Key = new("PlacedVariants.esp", "Data");

    private readonly PluginFixtureData _fixture;
    private readonly OpenedIndex _index;
    private readonly FormKey _cell, _arrow, _hazard, _projectile, _hazardBase;

    public PlacedVariantIndexingTests()
    {
        FormKey cell = default, arrow = default, hazard = default, projectile = default, hazardBase = default;
        _fixture = new PluginFixtureBuilder("placed-variants")
            .WithPlugin(Key.Name, mod =>
            {
                var projectileRecord = mod.Projectiles.AddNew("ArrowProjectile");
                var hazardRecord = mod.Hazards.AddNew("FireHazard");
                var interior = new Cell(mod) { EditorID = "VariantCell" };
                var arrowRef = new PlacedArrow(mod) { EditorID = "arrowRef", Position = new P3Float(1f, 2f, 3f) };
                arrowRef.Projectile.SetTo(projectileRecord);
                var hazardRef = new PlacedHazard(mod) { EditorID = "hazardRef" };
                hazardRef.Hazard.SetTo(hazardRecord);
                interior.Temporary.Add(arrowRef);
                interior.Persistent.Add(hazardRef);
                var sub = new CellSubBlock { BlockNumber = 0 };
                sub.Cells.Add(interior);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(sub);
                mod.Cells.Records.Add(block);
                (cell, arrow, hazard, projectile, hazardBase) =
                    (interior.FormKey, arrowRef.FormKey, hazardRef.FormKey, projectileRecord.FormKey, hazardRecord.FormKey);
            })
            .Build();
        _index = Indexes.Reconciled(_fixture);
        (_cell, _arrow, _hazard, _projectile, _hazardBase) = (cell, arrow, hazard, projectile, hazardBase);
    }

    private IRecordReads Reads => _index.RequireReads();

    [Fact]
    public void EachVariant_ResolvesUnderItsOwnSignature()
    {
        Assert.Equal(new RecordLookupEntry("parw", "arrowRef"), Reads.Resolve(_arrow.ToString()));
        Assert.Equal(new RecordLookupEntry("phzd", "hazardRef"), Reads.Resolve(_hazard.ToString()));
    }

    [Fact]
    public void EachVariant_IsAChildOfItsCell_InItsPlacementGroup()
    {
        var children = Reads.GetCellChildRecords(Key, _cell.ToString());

        Assert.Equal([_arrow.ToString()], children.Temporary.Select(c => c.FormKey));
        Assert.Equal([_hazard.ToString()], children.Persistent.Select(c => c.FormKey));
    }

    [Fact]
    public void EachVariant_HasAPlacementInItsCell()
    {
        var arrow = Reads.GetPlacement(_arrow.ToString(), Key);

        Assert.NotNull(arrow);
        Assert.Equal(_cell.ToString(), arrow.Value.ParentCell);
        Assert.Equal(1f, arrow.Value.PosX);
        Assert.Equal("persistent", Reads.GetPlacement(_hazard.ToString(), Key)?.PlacementGroup);
    }

    [Fact]
    public void EachVariant_ReferencesTheRecordItPlaces()
    {
        Assert.Contains(Reads.GetReferencedBy(_projectile.ToString()), r => r.FormKey == _arrow.ToString() && r.RecordType == "parw");
        Assert.Contains(Reads.GetReferencedBy(_hazardBase.ToString()), r => r.FormKey == _hazard.ToString() && r.RecordType == "phzd");
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }
}
