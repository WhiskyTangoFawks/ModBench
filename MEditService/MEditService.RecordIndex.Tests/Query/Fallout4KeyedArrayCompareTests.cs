using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class Fallout4KeyedArrayCopies : IDisposable
{
    private readonly PluginFixtureData _fixture;

    public Fallout4KeyedArrayCopies()
    {
        _fixture = new PluginFixtureBuilder("medit-keyed-array-compare")
            .WithPlugin(Fallout4KeyedArrayCompareTests.BasePlugin, mod => Fallout4KeyedArrayCompareTests.Hold(mod, reversed: false))
            .WithPlugin(Fallout4KeyedArrayCompareTests.TopPlugin, mod => Fallout4KeyedArrayCompareTests.Hold(mod, reversed: true))
            .Build();
        Index = Indexes.Reconciled(_fixture);
    }

    internal OpenedIndex Index { get; }

    public void Dispose()
    {
        Index.Dispose();
        _fixture.Dispose();
    }
}

public sealed class Fallout4KeyedArrayCompareTests(Fallout4KeyedArrayCopies copies) : IClassFixture<Fallout4KeyedArrayCopies>
{
    internal const string BasePlugin = "Base.esm";
    internal const string TopPlugin = "Top.esp";

    private static readonly ModKey Base = ModKey.FromFileName(BasePlugin);
    private static readonly FormKey FactionKey = new(Base, 0x801);
    private static readonly FormKey MiscItemKey = new(Base, 0x803);
    private static readonly FormKey ContainerKey = new(Base, 0x810);
    private static readonly FormKey A = new(Base, 0x900);
    private static readonly FormKey B = new(Base, 0x901);

    internal static void Hold(Fallout4Mod mod, bool reversed)
    {
        mod.Factions.Add(Faction(reversed));
        mod.Containers.Add(Container(reversed));
        mod.MiscItems.Add(MiscItem(reversed));
    }

    private static IEnumerable<T> InOrder<T>(bool reversed, params T[] items) => reversed ? items.Reverse() : items;

    private static Faction Faction(bool reversed) => new(FactionKey, Fallout4Release.Fallout4)
    {
        Relations = [.. InOrder(reversed,
            new Relation { Target = new FormLink<IRelatableGetter>(A), Modifier = 1 },
            new Relation { Target = new FormLink<IRelatableGetter>(B), Modifier = 2 })],
        Ranks = [.. InOrder(reversed, new Rank { Number = 1, Insignia = "a" }, new Rank { Number = 2, Insignia = "b" })],
    };

    private static Container Container(bool reversed) => new(ContainerKey, Fallout4Release.Fallout4)
    {
        Items = [.. InOrder(reversed,
            ItemEntry(A, 1),
            ItemEntry(A, 2),
            ItemEntry(A, 2, new ExtraData { ItemCondition = 0.5f }),
            ItemEntry(A, 2, new ExtraData { ItemCondition = 0.5f, Owner = new NpcOwner { Npc = new FormLink<INpcGetter>(A), Global = new FormLink<IGlobalGetter>(B) } }),
            ItemEntry(A, 2, new ExtraData { ItemCondition = 0.5f, Owner = new FactionOwner { Faction = new FormLink<IFactionGetter>(A), RequiredRank = 1 } }),
            ItemEntry(B, 1))],
    };

    private static ContainerEntry ItemEntry(FormKey item, int count, ExtraData? data = null) =>
        new() { Item = new ContainerItem { Item = new FormLink<IItemGetter>(item), Count = count }, Data = data };

    private static MiscItem MiscItem(bool reversed) => new(MiscItemKey, Fallout4Release.Fallout4)
    {
        Components = [.. InOrder(reversed,
            new MiscItemComponent { Component = new FormLink<IComponentGetter>(A), Count = 1 },
            new MiscItemComponent { Component = new FormLink<IComponentGetter>(B), Count = 2 })],
        ComponentDisplayIndices = [0, 1],
    };

    private static readonly Dictionary<string, (FormKey Record, string[] Arrays, ConflictThis TopCopy, ConflictAll TopCopyAll)> Alignments = new()
    {
        ["an array keyed by one member aligns its elements by that key"] =
            (FactionKey, ["Relations", "Ranks"], ConflictThis.IdenticalToMaster, ConflictAll.NoConflict),
        ["elements sharing a key align in the order their extended key sorts them"] =
            (ContainerKey, ["Items"], ConflictThis.IdenticalToMaster, ConflictAll.NoConflict),
        ["an array xEdit leaves unsorted aligns in sequence"] =
            (MiscItemKey, ["Components"], ConflictThis.Override, ConflictAll.Override),
    };

    public static TheoryData<string> AlignmentPaths => [.. Alignments.Keys];

    [Theory]
    [MemberData(nameof(AlignmentPaths))]
    public void ACopyHoldingItsArraysInAnotherOrder_ReadsAsXEditsAlignmentDoes(string path)
    {
        var (record, arrays, topCopy, topCopyAll) = Alignments[path];
        var compare = copies.Index.Queries.GetCompare(record.ToString()).Value()
            ?? throw new InvalidOperationException($"Expected {record} to resolve to a compare result.");

        var diffs = compare.Diffs.Where(d => arrays.Contains(d.FieldName)).ToList();
        Assert.Equal(arrays.Order(), diffs.Select(d => d.FieldName).Order());
        Assert.All(diffs, d => Assert.Equal((topCopy, topCopyAll), (d.CellStates[TopPlugin], d.ConflictAll)));
    }
}
