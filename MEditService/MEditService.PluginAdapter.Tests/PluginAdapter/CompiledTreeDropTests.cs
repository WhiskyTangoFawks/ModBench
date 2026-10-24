using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
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
        Assert.Equal(["Aliases[1]"], drop.Paths);
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

        Assert.Equal(["Aliases[1]"], Assert.Single(await DropsOf(mod)).Paths);
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
            [(faction.FormKey.ToString(), new[] { "Ranks[0]", "Ranks[1]" }), (npc.FormKey.ToString(), new[] { "Attacks[0]" })],
            drops.Select(drop => (drop.Record.FormKey, drop.Paths.ToArray())).OrderBy(drop => drop.FormKey, StringComparer.Ordinal));
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

    [Theory]
    [InlineData(0)]
    [InlineData(5)]
    public async Task DropsIn_OfAUnionThatReadsBackAsAnotherKind_NamesNothing_ForTheKindIsMutagensToDecide(int data)
    {
        var mod = NewMod();
        mod.Factions.AddNew("Faction").VendorLocation = new LocationTargetRadius
        {
            Radius = 1,
            Target = new LocationFallback { Type = LocationTargetRadius.LocationType.NearReference, Data = data },
        };

        Assert.Empty(await DropsOf(mod));
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
