using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Index.Tests.Indexing;

public sealed class PlacedVariantIndexingTests(PlacedVariantIndexingTests.Built built) : IClassFixture<PlacedVariantIndexingTests.Built>
{
    private static readonly string[] VariantTables = ["parw", "pbar", "pbea", "pcon", "pfla", "pgre", "phzd", "pmis"];

    public static TheoryData<string> Variants { get; } = [.. VariantTables];

    private static readonly PluginAddress Key = new("PlacedVariants.esp", "Data");

    internal sealed record Placed(FormKey FormKey, string EditorId, FormKey Base, string Group, float X);

    public sealed class Built : IDisposable
    {
        private readonly PluginFixtureData _fixture;
        private readonly OpenedIndex _index;

        public Built()
        {
            var placed = new Dictionary<string, Placed>(StringComparer.Ordinal);
            FormKey cell = default;
            _fixture = new PluginFixtureBuilder("placed-variants")
                .WithPlugin(Key.Name, mod =>
                {
                    var projectile = mod.Projectiles.AddNew("VariantProjectile");
                    var hazard = mod.Hazards.AddNew("VariantHazard");
                    var interior = new Cell(mod) { EditorID = "VariantCell" };
                    foreach (var (table, index) in VariantTables.Select((table, index) => (table, index)))
                    {
                        var (record, baseRecord) = Variant(mod, table, projectile, hazard);
                        record.EditorID = $"{table}Ref";
                        ((IPositionRotation)record).Position = new P3Float(index + 1, 0, 0);
                        var persistent = index % 2 == 0;
                        (persistent ? interior.Persistent : interior.Temporary).Add(record);
                        placed[table] = new Placed(
                            record.FormKey, $"{table}Ref", baseRecord, persistent ? "persistent" : "temporary", index + 1);
                    }
                    var sub = new CellSubBlock { BlockNumber = 0 };
                    sub.Cells.Add(interior);
                    var block = new CellBlock { BlockNumber = 0 };
                    block.SubBlocks.Add(sub);
                    mod.Cells.Records.Add(block);
                    cell = interior.FormKey;
                })
                .Build();
            _index = Indexes.Reconciled(_fixture);
            (Cell, PlacedByTable) = (cell, placed);
        }

        public FormKey Cell { get; }
        internal IReadOnlyDictionary<string, Placed> PlacedByTable { get; }
        public IRecordReads Reads => _index.RequireReads();

        public void Dispose()
        {
            _index.Dispose();
            _fixture.Dispose();
        }

        private static (APlacedTrap Record, FormKey Base) Variant(Fallout4Mod mod, string table, Projectile projectile, Hazard hazard)
        {
            if (table == "phzd")
            {
                var placedHazard = new PlacedHazard(mod);
                placedHazard.Hazard.SetTo(hazard);
                return (placedHazard, hazard.FormKey);
            }

            APlacedTrap record = table switch
            {
                "parw" => new PlacedArrow(mod) { Projectile = projectile.ToLink() },
                "pbar" => new PlacedBarrier(mod) { Projectile = projectile.ToLink() },
                "pbea" => new PlacedBeam(mod) { Projectile = projectile.ToLink() },
                "pcon" => new PlacedCone(mod) { Projectile = projectile.ToLink() },
                "pfla" => new PlacedFlame(mod) { Projectile = projectile.ToLink() },
                "pgre" => new PlacedTrap(mod) { Projectile = projectile.ToLink() },
                "pmis" => new PlacedMissile(mod) { Projectile = projectile.ToLink() },
                _ => throw new ArgumentOutOfRangeException(nameof(table), table, "no placed variant"),
            };
            return (record, projectile.FormKey);
        }
    }

    private Placed Of(string table) => built.PlacedByTable[table];

    [Theory]
    [MemberData(nameof(Variants))]
    public void AVariant_ResolvesUnderItsOwnSignature(string table)
    {
        Assert.Equal(new RecordLookupEntry(table, Of(table).EditorId), built.Reads.Resolve(Of(table).FormKey.ToString()));
    }

    [Theory]
    [MemberData(nameof(Variants))]
    public void AVariant_IsAChildOfItsCell_InItsPlacementGroup(string table)
    {
        var children = built.Reads.GetCellChildRecords(Key, built.Cell.ToString());
        var group = Of(table).Group == "persistent" ? children.Persistent : children.Temporary;

        var child = Assert.Single(group, c => c.FormKey == Of(table).FormKey.ToString());
        Assert.Equal(table, child.RecordType);
    }

    [Theory]
    [MemberData(nameof(Variants))]
    public void AVariant_IsPlacedInItsCell_AtItsPosition(string table)
    {
        var placement = built.Reads.GetPlacement(Of(table).FormKey.ToString(), Key);

        Assert.NotNull(placement);
        Assert.Equal(built.Cell.ToString(), placement.Value.ParentCell);
        Assert.Equal(Of(table).X, placement.Value.PosX);
    }

    [Theory]
    [MemberData(nameof(Variants))]
    public void AVariant_IsPlacedInThePlacementGroupItsCellHoldsItIn(string table)
    {
        Assert.Equal(Of(table).Group, built.Reads.GetPlacement(Of(table).FormKey.ToString(), Key)?.PlacementGroup);
    }

    [Theory]
    [MemberData(nameof(Variants))]
    public void AVariant_ReferencesTheRecordItPlaces(string table)
    {
        Assert.Contains(
            built.Reads.GetReferencedBy(Of(table).Base.ToString()),
            r => r.FormKey == Of(table).FormKey.ToString() && r.RecordType == table);
    }
}
