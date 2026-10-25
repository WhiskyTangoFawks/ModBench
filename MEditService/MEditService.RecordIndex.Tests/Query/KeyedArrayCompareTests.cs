using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Starfield;
using Noggog;
using Fallout4 = Mutagen.Bethesda.Fallout4;
using Starfield = Mutagen.Bethesda.Starfield;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class KeyedArrayCopies : IDisposable
{
    private readonly PluginFixtureData _fallout4Plugins;
    private readonly ScratchDirectory _starfieldPlugins = new("medit-starfield-keyed-arrays-");

    public KeyedArrayCopies()
    {
        _fallout4Plugins = new PluginFixtureBuilder("medit-keyed-array-compare")
            .WithPlugin(KeyedArrayCompareTests.BasePlugin, mod => KeyedArrayCompareTests.Hold(mod, reversed: false))
            .WithPlugin(KeyedArrayCompareTests.TopPlugin, mod => KeyedArrayCompareTests.Hold(mod, reversed: true))
            .Build();
        Fallout4Index = Indexes.Reconciled(_fallout4Plugins);

        var holder = new LoadOrderHolder();
        StarfieldIndex = Indexes.Open(holder);
        StarfieldIndex.Reconcile(holder, _starfieldPlugins.Path, KeyedArrayCompareTests.WriteStarfieldPlugins(_starfieldPlugins.Path), GameRelease.Starfield);
    }

    internal OpenedIndex Fallout4Index { get; }

    internal OpenedIndex StarfieldIndex { get; }

    public void Dispose()
    {
        Fallout4Index.Dispose();
        StarfieldIndex.Dispose();
        _fallout4Plugins.Dispose();
        _starfieldPlugins.Dispose();
    }
}

public sealed class KeyedArrayCompareTests(KeyedArrayCopies copies) : IClassFixture<KeyedArrayCopies>
{
    internal const string BasePlugin = "Base.esm";
    internal const string TopPlugin = "Top.esp";

    private static readonly ModKey Base = ModKey.FromFileName(BasePlugin);
    private static readonly ModKey Top = ModKey.FromFileName(TopPlugin);
    private static readonly FormKey FactionKey = new(Base, 0x801);
    private static readonly FormKey MiscItemKey = new(Base, 0x803);
    private static readonly FormKey ContainerKey = new(Base, 0x810);
    private static readonly FormKey LeveledPackInKey = new(Base, 0x820);
    private static readonly FormKey A = new(Base, 0x900);
    private static readonly FormKey B = new(Base, 0x901);

    internal static void Hold(Fallout4.Fallout4Mod mod, bool reversed)
    {
        mod.Factions.Add(Faction(reversed));
        mod.Containers.Add(Container(reversed));
        mod.MiscItems.Add(MiscItem(reversed));
    }

    private static IEnumerable<T> InOrder<T>(bool reversed, params T[] items) => reversed ? items.Reverse() : items;

    private static Fallout4.Faction Faction(bool reversed) => new(FactionKey, Fallout4.Fallout4Release.Fallout4)
    {
        Relations = [.. InOrder(reversed,
            new Fallout4.Relation { Target = new FormLink<Fallout4.IRelatableGetter>(A), Modifier = 1 },
            new Fallout4.Relation { Target = new FormLink<Fallout4.IRelatableGetter>(B), Modifier = 2 })],
        Ranks = [.. InOrder(reversed, new Fallout4.Rank { Number = 1, Insignia = "a" }, new Fallout4.Rank { Number = 2, Insignia = "b" })],
    };

    private static Fallout4.Container Container(bool reversed) => new(ContainerKey, Fallout4.Fallout4Release.Fallout4)
    {
        Items = [.. InOrder(reversed,
            ItemEntry(A, 1),
            ItemEntry(A, 2),
            ItemEntry(A, 2, new Fallout4.ExtraData { ItemCondition = 0.5f }),
            ItemEntry(A, 2, new Fallout4.ExtraData
            {
                ItemCondition = 0.5f,
                Owner = new Fallout4.NpcOwner { Npc = new FormLink<Fallout4.INpcGetter>(A), Global = new FormLink<Fallout4.IGlobalGetter>(B) },
            }),
            ItemEntry(A, 2, new Fallout4.ExtraData
            {
                ItemCondition = 0.5f,
                Owner = new Fallout4.FactionOwner { Faction = new FormLink<Fallout4.IFactionGetter>(A), RequiredRank = 1 },
            }),
            ItemEntry(B, 1))],
    };

    private static Fallout4.ContainerEntry ItemEntry(FormKey item, int count, Fallout4.ExtraData? data = null) =>
        new() { Item = new Fallout4.ContainerItem { Item = new FormLink<Fallout4.IItemGetter>(item), Count = count }, Data = data };

    private static Fallout4.MiscItem MiscItem(bool reversed) => new(MiscItemKey, Fallout4.Fallout4Release.Fallout4)
    {
        Components = [.. InOrder(reversed,
            new Fallout4.MiscItemComponent { Component = new FormLink<Fallout4.IComponentGetter>(A), Count = 1 },
            new Fallout4.MiscItemComponent { Component = new FormLink<Fallout4.IComponentGetter>(B), Count = 2 })],
        ComponentDisplayIndices = [0, 1],
    };

    internal static IReadOnlyList<LoadOrderEntry> WriteStarfieldPlugins(string folder)
    {
        var master = new Starfield.StarfieldMod(Base, Starfield.StarfieldRelease.Starfield);
        master.LeveledPackIns.Add(LeveledPackIn(reversed: false));
        var basePath = Path.Combine(folder, Base.FileName);
        master.WriteToBinary(basePath);

        var top = new Starfield.StarfieldMod(Top, Starfield.StarfieldRelease.Starfield);
        top.ModHeader.MasterReferences.Add(new MasterReference { Master = Base });
        top.LeveledPackIns.Add(LeveledPackIn(reversed: true));
        var topPath = Path.Combine(folder, Top.FileName);
        top.WriteToBinary(topPath, new BinaryWriteParameters
        {
            MastersListContent = MastersListContentOption.NoCheck,
            MasterFlagsLookup = new Cache<IModMasterStyledGetter, ModKey>(m => m.ModKey) { master },
        });
        return
        [
            new LoadOrderEntry(Base.FileName, basePath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry(Top.FileName, topPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
        ];
    }

    private static Starfield.LeveledPackIn LeveledPackIn(bool reversed) => new(LeveledPackInKey, Starfield.StarfieldRelease.Starfield)
    {
        Entries = [.. InOrder(reversed, EntryHeldWhen(1), EntryHeldWhen(2))],
    };

    private static Starfield.LeveledPackInEntry EntryHeldWhen(float comparison)
    {
        var entry = new Starfield.LeveledPackInEntry { Level = 1, Count = 1 };
        entry.Reference.SetTo(A);
        entry.Conditions.Add(new Starfield.ConditionFloat { Data = new Starfield.GetIsIDConditionData(), ComparisonValue = comparison });
        return entry;
    }

    private static readonly Dictionary<string, (Func<KeyedArrayCopies, OpenedIndex> Index, FormKey Record, string[] Arrays, ConflictThis TopCopy, ConflictAll TopCopyAll)> Alignments = new()
    {
        ["an array keyed by one member aligns its elements by that key"] =
            (c => c.Fallout4Index, FactionKey, ["Relations", "Ranks"], ConflictThis.IdenticalToMaster, ConflictAll.NoConflict),
        ["elements sharing a key align in the order their extended key sorts them"] =
            (c => c.Fallout4Index, ContainerKey, ["Items"], ConflictThis.IdenticalToMaster, ConflictAll.NoConflict),
        ["elements sharing a key align in the order an array member of their extended key sorts them"] =
            (c => c.StarfieldIndex, LeveledPackInKey, ["Entries"], ConflictThis.IdenticalToMaster, ConflictAll.NoConflict),
        ["an array xEdit leaves unsorted aligns in sequence"] =
            (c => c.Fallout4Index, MiscItemKey, ["Components"], ConflictThis.Override, ConflictAll.Override),
    };

    public static TheoryData<string> AlignmentPaths => [.. Alignments.Keys];

    [Theory]
    [MemberData(nameof(AlignmentPaths))]
    public void ACopyHoldingItsArraysInAnotherOrder_ReadsAsXEditsAlignmentDoes(string path)
    {
        var (index, record, arrays, topCopy, topCopyAll) = Alignments[path];
        var compare = index(copies).Queries.GetCompare(record.ToString()).Value()
            ?? throw new InvalidOperationException($"Expected {record} to resolve to a compare result.");

        var diffs = compare.Diffs.Where(d => arrays.Contains(d.FieldName)).ToList();
        Assert.Equal(arrays.Order(), diffs.Select(d => d.FieldName).Order());
        Assert.All(diffs, d => Assert.Equal((topCopy, topCopyAll), (d.CellStates[TopPlugin], d.ConflictAll)));
    }
}
