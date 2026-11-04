using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class CompiledTreeDropTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();
    private static readonly ModKey Plugin = ModKey.FromFileName("Drops.esp");

    [Fact]
    public async Task DropsIn_OfACollectionAliasWithNoMember_NamesIt()
    {
        var mod = NewMod();
        var quest = mod.Quests.AddNew("Quest");
        quest.Aliases = [new QuestReferenceAlias { Name = "Kept" }, new QuestCollectionAlias()];

        var drop = Assert.Single(await DropsOf(mod));

        Assert.Equal(quest.FormKey.ToString(), drop.Record.FormKey);
        Assert.Equal("Aliases", drop.Field);
    }

    [Fact]
    public async Task DropsIn_OfTwoAdjacentCollectionAliases_NamesTheSecond_WhichReadsBackMergedIntoTheFirst()
    {
        var mod = NewMod();
        var quest = mod.Quests.AddNew("Quest");
        quest.Aliases =
        [
            new QuestCollectionAlias { Collection = [new CollectionAlias { AliasID = 3 }] },
            new QuestCollectionAlias { Collection = [new CollectionAlias { AliasID = 4 }] },
        ];

        Assert.Equal("Aliases", Assert.Single(await DropsOf(mod)).Field);
    }

    [Fact]
    public async Task DropsIn_NamesEveryDrop_OfEveryRecord()
    {
        var mod = NewMod();
        var faction = mod.Factions.AddNew("Faction");
        faction.Ranks.Add(new Rank());
        faction.Ranks.Add(new Rank());
        var npc = mod.Npcs.AddNew("Npc");
        npc.Attacks.Add(new Attack());

        var drops = await DropsOf(mod);

        Assert.Equal(
            [(faction.FormKey.ToString(), "Ranks"), (npc.FormKey.ToString(), "Attacks")],
            drops.Select(drop => (drop.Record.FormKey, drop.Field)).OrderBy(drop => drop.FormKey, StringComparer.Ordinal));
    }

    [Fact]
    public async Task DropsIn_OfACellWithNoChildren_IgnoresItsGroupHeaderFields_WhichMutagenWritesOnlyWithAChildGroup()
    {
        var mod = NewMod();
        var cell = new Cell(mod)
        {
            EditorID = "Cell",
            Timestamp = 1,
            UnknownGroupData = 2,
            PersistentTimestamp = 3,
            PersistentUnknownGroupData = 4,
            TemporaryTimestamp = 5,
            TemporaryUnknownGroupData = 6,
        };
        mod.AddInteriorCells(cell);

        Assert.Empty(await DropsOf(mod));
    }

    [Fact]
    public async Task DropsIn_OfAQuestAndATopicWithNoChildren_IgnoresTheirGroupHeaderFields_WhichMutagenWritesOnlyWithAChildGroup()
    {
        var mod = NewMod();
        var quest = mod.Quests.AddNew("Quest");
        quest.Timestamp = 1;
        quest.Unknown = 2;
        var withTopic = mod.Quests.AddNew("QuestWithTopic");
        withTopic.DialogTopics.Add(new DialogTopic(mod) { Quest = withTopic.ToLink(), Timestamp = 3, Unknown = 4 });

        Assert.Empty(await DropsOf(mod));
    }

    [Fact]
    public async Task DropsIn_OfAUnionOfAKindMutagenNeverReadsForItsType_NamesIt()
    {
        var mod = NewMod();
        mod.Factions.AddNew("Faction").VendorLocation = new LocationTargetRadius
        {
            Radius = 1,
            Target = new LocationFallback { Type = LocationTargetRadius.LocationType.NearReference, Data = 5 },
        };

        Assert.Equal("VendorLocation.Target.MutagenObjectType", Assert.Single(await DropsOf(mod)).Field);
    }

    [Fact]
    public async Task DropsIn_OfMutagensDefaultLocationTarget_NamesNothing_ForAnEditThatLeavesTheTargetWritesIt()
    {
        var mod = NewMod();
        mod.Factions.AddNew("Faction").VendorLocation = new LocationTargetRadius { Radius = 1 };

        Assert.Empty(await DropsOf(mod));
    }

    [Fact]
    public async Task DropsIn_OfAPackageWhoseDataIsOutOfKeyOrder_NamesNothing_ThoughMutagenWritesItSortedByKey()
    {
        var mod = NewMod();
        var package = mod.Packages.AddNew("Package");
        package.Data.Add(2, new PackageDataInt { Data = 7 });
        package.Data.Add(1, new PackageDataInt());

        Assert.Empty(await DropsOf(mod));
    }

    [Fact]
    public async Task DropsIn_OfAPackageDataEntryWithNoValue_NamesThePackagesData_ThoughItsOtherEntriesSurvive()
    {
        var mod = NewMod();
        var package = mod.Packages.AddNew("Package");
        package.Data.Add(3, new APackageData());
        package.Data.Add(5, new PackageDataInt { Data = 7 });

        var drop = Assert.Single(await DropsOf(mod));

        Assert.Equal((package.FormKey.ToString(), "Data"), (drop.Record.FormKey, drop.Field));
    }

    [Fact]
    public async Task DropsIn_OfAStringInAPluginNotLocalized_NamesNothing_ThoughItsLanguageIsNotTheOneMutagenReadsItIn()
    {
        var mod = NewMod();
        mod.Doors.AddNew("Door").Name = new TranslatedString(Language.French, "La Porte");

        Assert.Empty(await DropsOf(mod));
    }

    [Fact]
    public async Task DropsIn_OfAStringInALocalizedPlugin_NamesIt_WhenItsOneTextIsInALanguageTheReadDoesNotGive()
    {
        var mod = NewMod();
        mod.UsingLocalization = true;
        mod.Doors.AddNew("Door").Name = new TranslatedString(Language.French, "La Porte");

        Assert.Equal("Name", Assert.Single(await DropsOf(mod)).Field);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DropsIn_OfADeletedReferenceHoldingOnlyItsBaseRecord_NamesNothing_ForMutagenWritesADeletedRecordAsItsHeaderAlone(bool trap)
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        cell.Persistent.Add(DeletedReference(mod, trap, editorId: null));
        mod.AddInteriorCells(cell);

        Assert.Empty(await DropsOf(mod));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DropsIn_OfADeletedReferenceHoldingAFieldBesideItsBaseRecord_NamesTheField(bool trap)
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "Cell" };
        var reference = DeletedReference(mod, trap, editorId: "Ref");
        cell.Persistent.Add(reference);
        mod.AddInteriorCells(cell);

        var drops = await DropsOf(mod);

        Assert.Contains((reference.FormKey.ToString(), "EditorID"), drops.Select(drop => (drop.Record.FormKey, drop.Field)));
    }

    [Fact]
    public async Task DropsIn_OfADeletedNpcHoldingAField_NamesTheField()
    {
        var mod = NewMod();
        var npc = new Npc(mod) { EditorID = "Guy", MajorRecordFlagsRaw = (int)DeletedFlag.Bit };
        mod.Npcs.Add(npc);

        var drop = Assert.Single(await DropsOf(mod));

        Assert.Equal((npc.FormKey.ToString(), "EditorID"), (drop.Record.FormKey, drop.Field));
    }

    private static IPlaced DeletedReference(Fallout4Mod mod, bool trap, string? editorId)
    {
        var baseRecord = FormKey.Factory($"000801:{Plugin.FileName}");
        IPlaced reference = trap
            ? new PlacedMissile(mod) { Projectile = new FormLink<IProjectileGetter>(baseRecord) }
            : new PlacedObject(mod) { Base = new FormLinkNullable<IPlaceableObjectGetter>(baseRecord) };
        reference.EditorID = editorId;
        reference.MajorRecordFlagsRaw = (int)DeletedFlag.Bit;
        return reference;
    }

    private static Fallout4Mod NewMod() => new(Plugin, Fallout4Release.Fallout4);

    private static async Task<IReadOnlyList<DroppedValue>> DropsOf(Fallout4Mod mod)
    {
        using var scratch = new ScratchDirectory("medit-drops-");
        var treeFolder = Directory.CreateDirectory(Path.Combine(scratch.Path, "tree")).FullName;
        await GameCodecs.For(GameRelease.Fallout4).SerializeWholeMod(mod, treeFolder, InlineWorkDropoff.Instance, CancellationToken.None);
        var files = Directory.EnumerateFiles(treeFolder, "*", SearchOption.AllDirectories)
            .Select(file => new TreeFile(Path.GetRelativePath(treeFolder, file), File.ReadAllBytes(file)))
            .ToList();
        var tree = (await Adapter.ReadTreeAsync(files, EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();
        return (await tree.SaveAsync(Path.Combine(scratch.Path, Plugin.FileName), [Plugin.FileName.String], [], tree.DropsIn)).Answered();
    }
}
