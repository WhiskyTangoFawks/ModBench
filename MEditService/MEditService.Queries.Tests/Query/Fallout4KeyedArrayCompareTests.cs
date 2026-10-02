using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class Fallout4KeyedArrayCompareTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress TopPlugin = new("Top.esp", "Data");

    private static readonly ModKey Base = ModKey.FromFileName(BasePlugin.Name);
    private static readonly FormKey NpcKey = new(Base, 0x800);
    private static readonly FormKey FactionKey = new(Base, 0x801);
    private static readonly FormKey LeveledItemKey = new(Base, 0x802);
    private static readonly FormKey ObjectModKey = new(Base, 0x803);
    private static readonly FormKey PerkKey = new(Base, 0x804);
    private static readonly FormKey QuestKey = new(Base, 0x805);
    private static readonly FormKey LocationKey = new(Base, 0x806);
    private static readonly FormKey TerminalKey = new(Base, 0x807);
    private static readonly FormKey MagicEffectKey = new(Base, 0x808);
    private static readonly FormKey PlacedNpcKey = new(Base, 0x809);
    private static readonly FormKey PlacedObjectKey = new(Base, 0x80A);
    private static readonly FormKey A = new(Base, 0x900);
    private static readonly FormKey B = new(Base, 0x901);

    private static readonly (FormKey Key, string RecordType, string[] Fields, Func<bool, IMajorRecordGetter> Build)[] Records =
    [
        (NpcKey, "npc_", ["Factions", "Perks", "Items", "Attacks", "Sounds", "FaceMorphs", "FaceTintingLayers", "Properties"], Npc),
        (FactionKey, "fact", ["Relations", "Ranks"], Faction),
        (LeveledItemKey, "lvli", ["Entries", "FilterKeywordChances"], LeveledItem),
        (ObjectModKey, "omod", ["Properties"], WeaponModification),
        (PerkKey, "perk", ["Effects"], Perk),
        (QuestKey, "qust", ["Stages"], Quest),
        (LocationKey, "lctn", [
            "PersistentActorReferencesAdded", "PersistentActorReferencesStatic", "UniqueActorReferencesAdded",
            "UniqueActorReferencesStatic", "LocationRefTypeReferencesAdded", "LocationRefTypeReferencesStatic",
            "WorldspaceCellsAdded", "WorldspaceCellsStatic", "WorldspaceCellsRemoved"], Location),
        (TerminalKey, "term", ["VirtualMachineAdapter", "Properties"], Terminal),
        (MagicEffectKey, "mgef", ["Sounds"], MagicEffect),
        (PlacedNpcKey, "achr", ["LinkedReferences", "ActivateParents"], PlacedNpc),
        (PlacedObjectKey, "refr", ["LinkedReferences"], PlacedObject),
    ];

    private readonly RecordQueryService _service;

    public Fallout4KeyedArrayCompareTests()
    {
        var rows = Records.SelectMany(r => new[]
        {
            Row(r.Build(false), BasePlugin, 0, isWinner: false, r.RecordType, r.Fields),
            Row(r.Build(true), TopPlugin, 1, isWinner: true, r.RecordType, r.Fields),
        }).ToArray();
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: Records.Length),
            [TopPlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: [BasePlugin.Name], RecordCount: Records.Length),
        };
        var plugins = new[]
        {
            new LoadOrderEntry(BasePlugin.Name, BasePlugin.Name, "Data", 0, Enabled: true, Winning: true),
            new LoadOrderEntry(TopPlugin.Name, TopPlugin.Name, "Data", 1, Enabled: true, Winning: true),
        };
        _service = new RecordQueryService(
            new FakeIndex(new FakeReads(opened, rows)), FakeLoadOrder.Of(Release, plugins), SharedSchemaReflector.Instance, new ConflictClassifier());
    }

    private static IEnumerable<T> InOrder<T>(bool reversed, params T[] items) => reversed ? items.Reverse() : items;

    private static Npc Npc(bool reversed) => new(NpcKey, Fallout4Release.Fallout4)
    {
        Factions = [.. InOrder(reversed,
            new RankPlacement { Faction = new FormLink<IFactionGetter>(A), Rank = 1 },
            new RankPlacement { Faction = new FormLink<IFactionGetter>(B), Rank = 2 })],
        Perks = [.. InOrder(reversed,
            new PerkPlacement { Perk = new FormLink<IPerkGetter>(A), Rank = 1 },
            new PerkPlacement { Perk = new FormLink<IPerkGetter>(B), Rank = 2 })],
        Items = [.. InOrder(reversed,
            new ContainerEntry { Item = new ContainerItem { Item = new FormLink<IItemGetter>(A), Count = 1 } },
            new ContainerEntry { Item = new ContainerItem { Item = new FormLink<IItemGetter>(B), Count = 2 } })],
        Attacks = [.. InOrder(reversed,
            new Attack { AttackEvent = "attackStart", AttackData = new AttackData { DamageMult = 1 } },
            new Attack { AttackEvent = "bashStart", AttackData = new AttackData { DamageMult = 2 } })],
        Sounds = [.. InOrder(reversed,
            new NpcSound { Keyword = new FormLinkNullable<IKeywordGetter>(A), Sound = new FormLinkNullable<ISoundDescriptorGetter>(A) },
            new NpcSound { Keyword = new FormLinkNullable<IKeywordGetter>(B), Sound = new FormLinkNullable<ISoundDescriptorGetter>(B) })],
        FaceMorphs = [.. InOrder(reversed,
            new NpcFaceMorph { Index = 1, Scale = 1 },
            new NpcFaceMorph { Index = 2, Scale = 2 })],
        FaceTintingLayers = [.. InOrder(reversed,
            new NpcFaceTintingLayer { Index = 1, Value = 1 },
            new NpcFaceTintingLayer { Index = 2, Value = 2 })],
        Properties = [.. InOrder(reversed,
            new ObjectProperty { ActorValue = new FormLink<IActorValueInformationGetter>(A), Value = 1 },
            new ObjectProperty { ActorValue = new FormLink<IActorValueInformationGetter>(B), Value = 2 })],
    };

    private static Faction Faction(bool reversed) => new(FactionKey, Fallout4Release.Fallout4)
    {
        Relations = [.. InOrder(reversed,
            new Relation { Target = new FormLink<IRelatableGetter>(A), Modifier = 1 },
            new Relation { Target = new FormLink<IRelatableGetter>(B), Modifier = 2 })],
        Ranks = [.. InOrder(reversed, new Rank { Number = 1, Insignia = "a" }, new Rank { Number = 2, Insignia = "b" })],
    };

    private static LeveledItem LeveledItem(bool reversed) => new(LeveledItemKey, Fallout4Release.Fallout4)
    {
        Entries = [.. InOrder(reversed,
            new LeveledItemEntry { Data = new LeveledItemEntryData { Level = 1, Reference = new FormLink<IItemGetter>(A), Count = 1 } },
            new LeveledItemEntry { Data = new LeveledItemEntryData { Level = 1, Reference = new FormLink<IItemGetter>(B), Count = 2 } })],
        FilterKeywordChances = [.. InOrder(reversed,
            new FilterKeywordChance { FilterKeyword = new FormLink<IKeywordGetter>(A) },
            new FilterKeywordChance { FilterKeyword = new FormLink<IKeywordGetter>(B) })],
    };

    private static WeaponModification WeaponModification(bool reversed) => new(ObjectModKey, Fallout4Release.Fallout4)
    {
        Properties = [.. InOrder<AObjectModProperty<Weapon.Property>>(reversed,
            new ObjectModIntProperty<Weapon.Property> { Property = Weapon.Property.AmmoCapacity, Value = 1 },
            new ObjectModFloatProperty<Weapon.Property> { Property = Weapon.Property.Speed, Value = 2 })],
    };

    private static Perk Perk(bool reversed) => new(PerkKey, Fallout4Release.Fallout4)
    {
        Effects =
        [
            new PerkAbilityEffect
            {
                Ability = new FormLink<ISpellGetter>(A),
                Conditions = [.. InOrder(reversed,
                    new PerkCondition { RunOnTabIndex = 0 },
                    new PerkCondition { RunOnTabIndex = 1 })],
            },
        ],
    };

    private static Quest Quest(bool reversed) => new(QuestKey, Fallout4Release.Fallout4)
    {
        Stages = [.. InOrder(reversed, new QuestStage { Index = 10 }, new QuestStage { Index = 20 })],
    };

    private static Location Location(bool reversed) => new(LocationKey, Fallout4Release.Fallout4)
    {
        PersistentActorReferencesAdded = [.. PersistentActors(reversed)],
        PersistentActorReferencesStatic = [.. PersistentActors(reversed)],
        UniqueActorReferencesAdded = [.. UniqueActorsPlacedTwice(reversed)],
        UniqueActorReferencesStatic = [.. UniqueActorsPlacedTwice(reversed)],
        LocationRefTypeReferencesAdded = [.. LocationRefTypes(reversed)],
        LocationRefTypeReferencesStatic = [.. LocationRefTypes(reversed)],
        WorldspaceCellsAdded = [.. WorldspaceCells(reversed)],
        WorldspaceCellsStatic = [.. WorldspaceCells(reversed)],
        WorldspaceCellsRemoved = [.. WorldspaceCells(reversed)],
    };

    private static IEnumerable<PersistentActorReference> PersistentActors(bool reversed) => InOrder(reversed,
        new PersistentActorReference { Actor = new FormLink<IPlacedNpcGetter>(A) },
        new PersistentActorReference { Actor = new FormLink<IPlacedNpcGetter>(B) });

    private static IEnumerable<UniqueActorReference> UniqueActorsPlacedTwice(bool reversed) => InOrder(reversed,
        new UniqueActorReference { Actor = new FormLink<INpcGetter>(A), Ref = new FormLink<IPlacedNpcGetter>(A) },
        new UniqueActorReference { Actor = new FormLink<INpcGetter>(A), Ref = new FormLink<IPlacedNpcGetter>(B) });

    private static IEnumerable<LocationRefTypeReference> LocationRefTypes(bool reversed) => InOrder(reversed,
        new LocationRefTypeReference { LocationRefType = new FormLink<ILocationReferenceTypeGetter>(A), Ref = new FormLink<IPlacedGetter>(A) },
        new LocationRefTypeReference { LocationRefType = new FormLink<ILocationReferenceTypeGetter>(A), Ref = new FormLink<IPlacedGetter>(B) });

    private static IEnumerable<LocationCoordinate> WorldspaceCells(bool reversed) => InOrder(reversed,
        new LocationCoordinate { Location = new FormLink<IComplexLocationGetter>(A) },
        new LocationCoordinate { Location = new FormLink<IComplexLocationGetter>(B) });

    private static Terminal Terminal(bool reversed) => new(TerminalKey, Fallout4Release.Fallout4)
    {
        VirtualMachineAdapter = new VirtualMachineAdapterIndexed
        {
            ScriptFragments = new ScriptFragmentsIndexed
            {
                Script = new ScriptEntry { Name = "TerminalScript" },
                Fragments = [.. InOrder(reversed,
                    new ScriptFragmentIndexed { FragmentIndex = 1, ScriptName = "TerminalScript", FragmentName = "Fragment_1" },
                    new ScriptFragmentIndexed { FragmentIndex = 2, ScriptName = "TerminalScript", FragmentName = "Fragment_2" })],
            },
        },
        Properties = [.. InOrder(reversed,
            new ObjectProperty { ActorValue = new FormLink<IActorValueInformationGetter>(A), Value = 1 },
            new ObjectProperty { ActorValue = new FormLink<IActorValueInformationGetter>(B), Value = 2 })],
    };

    private static MagicEffect MagicEffect(bool reversed) => new(MagicEffectKey, Fallout4Release.Fallout4)
    {
        Sounds = [.. InOrder(reversed,
            new MagicEffectSound { Type = Mutagen.Bethesda.Fallout4.MagicEffect.SoundType.Charge, Sound = new FormLink<ISoundDescriptorGetter>(A) },
            new MagicEffectSound { Type = Mutagen.Bethesda.Fallout4.MagicEffect.SoundType.Release, Sound = new FormLink<ISoundDescriptorGetter>(B) })],
    };

    private static PlacedNpc PlacedNpc(bool reversed) => new(PlacedNpcKey, Fallout4Release.Fallout4)
    {
        Base = new FormLinkNullable<INpcGetter>(NpcKey),
        LinkedReferences = [.. InOrder(reversed,
            new LinkedReferences { KeywordOrReference = new FormLink<IKeywordLinkedReferenceGetter>(A), Reference = new FormLink<IPlacedGetter>(A) },
            new LinkedReferences { KeywordOrReference = new FormLink<IKeywordLinkedReferenceGetter>(B), Reference = new FormLink<IPlacedGetter>(B) })],
        ActivateParents = new ActivateParents
        {
            Parents = [.. InOrder(reversed,
                new ActivateParent { Reference = new FormLink<IPlacedGetter>(A), Delay = 1 },
                new ActivateParent { Reference = new FormLink<IPlacedGetter>(B), Delay = 2 })],
        },
    };

    private static PlacedObject PlacedObject(bool reversed) => new(PlacedObjectKey, Fallout4Release.Fallout4)
    {
        LinkedReferences = [.. InOrder(reversed,
            new LinkedReferences { KeywordOrReference = new FormLink<IKeywordLinkedReferenceGetter>(A), Reference = new FormLink<IPlacedGetter>(A) },
            new LinkedReferences { KeywordOrReference = new FormLink<IKeywordLinkedReferenceGetter>(B), Reference = new FormLink<IPlacedGetter>(B) })],
    };

    private static FakeRow Row(IMajorRecordGetter record, PluginAddress plugin, int loadOrderIndex, bool isWinner, string recordType, string[] fields) =>
        new(plugin, loadOrderIndex, isWinner, RealDocuments.Of(record, plugin, loadOrderIndex, isWinner, Release, recordType, fields));

    private void AssertTopCopyIsIdenticalToMaster(FormKey record) => AssertTopCopyIs(ConflictThis.IdenticalToMaster, record);

    private void AssertTopCopyIs(ConflictThis expected, FormKey record)
    {
        var compare = _service.GetCompare(record.ToString())
            ?? throw new InvalidOperationException($"Expected {record} to resolve to a compare result.");

        var topCells = compare.Diffs.Select(d => (d.FieldName, State: d.CellStates[TopPlugin.Name])).ToList();
        Assert.Equal(Records.Single(r => r.Key == record).Fields.Order(), topCells.Select(c => c.FieldName).Distinct().Order());
        Assert.All(topCells, cell => Assert.Equal(expected, cell.State));
    }

    [Fact]
    public void AnNpcCopyHoldingEveryKeyedArrayInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(NpcKey);

    [Fact]
    public void AFactionCopyHoldingItsRelationsAndRanksInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(FactionKey);

    [Fact]
    public void ALeveledItemCopyHoldingEntriesOfOneLevelInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(LeveledItemKey);

    [Fact]
    public void AnObjectModCopyHoldingPropertiesOfTwoKindsInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(ObjectModKey);

    [Fact]
    public void APerkCopyHoldingAnEffectsConditionsInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(PerkKey);

    [Fact]
    public void AQuestCopyHoldingItsStagesInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(QuestKey);

    [Fact]
    public void ALocationCopyHoldingEveryKeyedArrayInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(LocationKey);

    [Fact]
    public void ATerminalCopyHoldingItsFragmentsAndPropertiesInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(TerminalKey);

    [Fact]
    public void AMagicEffectCopyHoldingItsSoundsInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(MagicEffectKey);

    [Fact]
    public void APlacedNpcCopyHoldingItsLinkedReferencesAndActivateParentsInAnotherOrder_IsIdenticalToMaster() =>
        AssertTopCopyIsIdenticalToMaster(PlacedNpcKey);

    [Fact]
    public void APlacedObjectCopyHoldingItsLinkedReferencesInAnotherOrder_OverridesTheMaster_AsXEditsUnsortedArrayDoes() =>
        AssertTopCopyIs(ConflictThis.Override, PlacedObjectKey);
}
