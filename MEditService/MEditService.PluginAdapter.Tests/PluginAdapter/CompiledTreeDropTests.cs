using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog.WorkEngine;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class CompiledTreeDropTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();
    private static readonly ModKey Plugin = ModKey.FromFileName("Drops.esp");

    private static (string FormKey, string Field) Drop(IMajorRecordGetter record, string field) => (record.FormKey.ToString(), field);

    public static TheoryData<string, Func<Fallout4Mod, (string FormKey, string Field)[]>> Drops => new()
    {
        {
            "a collection alias with no member",
            mod =>
            {
                var quest = mod.Quests.AddNew("Quest");
                quest.Aliases = [new QuestReferenceAlias { Name = "Kept" }, new QuestCollectionAlias()];
                return [Drop(quest, "Aliases")];
            }
        },
        {
            "the second of two adjacent collection aliases, which reads back merged into the first",
            mod =>
            {
                var quest = mod.Quests.AddNew("Quest");
                quest.Aliases =
                [
                    new QuestCollectionAlias { Collection = [new CollectionAlias { AliasID = 3 }] },
                    new QuestCollectionAlias { Collection = [new CollectionAlias { AliasID = 4 }] },
                ];
                return [Drop(quest, "Aliases")];
            }
        },
        {
            "every drop of every record",
            mod =>
            {
                var faction = mod.Factions.AddNew("Faction");
                faction.Ranks.Add(new Rank());
                faction.Ranks.Add(new Rank());
                var npc = mod.Npcs.AddNew("Npc");
                npc.Attacks.Add(new Attack());
                return [Drop(faction, "Ranks"), Drop(npc, "Attacks")];
            }
        },
        {
            "a union of a kind Mutagen never reads for its type",
            mod =>
            {
                var faction = mod.Factions.AddNew("Faction");
                faction.VendorLocation = new LocationTargetRadius
                {
                    Radius = 1,
                    Target = new LocationFallback { Type = LocationTargetRadius.LocationType.NearReference, Data = 5 },
                };
                return [Drop(faction, "VendorLocation.Target.MutagenObjectType")];
            }
        },
        {
            "a package data entry with no value, though its other entries survive",
            mod =>
            {
                var package = mod.Packages.AddNew("Package");
                package.Data.Add(3, new APackageData());
                package.Data.Add(5, new PackageDataInt { Data = 7 });
                return [Drop(package, "Data")];
            }
        },
        {
            "a string in a localized plugin whose one text is in a language the read does not give",
            mod =>
            {
                mod.UsingLocalization = true;
                var door = mod.Doors.AddNew("Door");
                door.Name = new TranslatedString(Language.French, "La Porte");
                return [Drop(door, "Name")];
            }
        },
        {
            "a deleted NPC holding a field",
            mod =>
            {
                var npc = new Npc(mod) { EditorID = "Guy", MajorRecordFlagsRaw = (int)DeletedFlag.Bit };
                mod.Npcs.Add(npc);
                return [Drop(npc, "EditorID")];
            }
        },
        {
            "a cell with no children, whose group header fields Mutagen writes only with a child group",
            mod =>
            {
                mod.AddInteriorCells(new Cell(mod)
                {
                    EditorID = "Cell",
                    Timestamp = 1,
                    UnknownGroupData = 2,
                    PersistentTimestamp = 3,
                    PersistentUnknownGroupData = 4,
                    TemporaryTimestamp = 5,
                    TemporaryUnknownGroupData = 6,
                });
                return [];
            }
        },
        {
            "a quest and a topic with no children, whose group header fields Mutagen writes only with a child group",
            mod =>
            {
                var quest = mod.Quests.AddNew("Quest");
                quest.Timestamp = 1;
                quest.Unknown = 2;
                var withTopic = mod.Quests.AddNew("QuestWithTopic");
                withTopic.DialogTopics.Add(new DialogTopic(mod) { Quest = withTopic.ToLink(), Timestamp = 3, Unknown = 4 });
                return [];
            }
        },
        {
            "Mutagen's default location target, which an edit that leaves the target writes",
            mod =>
            {
                mod.Factions.AddNew("Faction").VendorLocation = new LocationTargetRadius { Radius = 1 };
                return [];
            }
        },
        {
            "a package whose data is out of key order, though Mutagen writes it sorted by key",
            mod =>
            {
                var package = mod.Packages.AddNew("Package");
                package.Data.Add(2, new PackageDataInt { Data = 7 });
                package.Data.Add(1, new PackageDataInt());
                return [];
            }
        },
        {
            "a string in a plugin not localized, though its language is not the one Mutagen reads it in",
            mod =>
            {
                mod.Doors.AddNew("Door").Name = new TranslatedString(Language.French, "La Porte");
                return [];
            }
        },
        { "a deleted reference holding only its base record", mod => DeletedReferenceInACell(mod, trap: false) },
        { "a deleted trap holding only its base record", mod => DeletedReferenceInACell(mod, trap: true) },
    };

    private static (string FormKey, string Field)[] DeletedReferenceInACell(Fallout4Mod mod, bool trap)
    {
        var cell = new Cell(mod) { EditorID = "Cell" };
        cell.Persistent.Add(DeletedReference(mod, trap, editorId: null));
        mod.AddInteriorCells(cell);
        return [];
    }

    [Theory]
    [MemberData(nameof(Drops))]
    public async Task DropsIn_NamesEachValueThePluginWrittenFromTheTreeDoesNotHold(string _, Func<Fallout4Mod, (string FormKey, string Field)[]> shape)
    {
        var mod = NewMod();
        var expected = shape(mod);

        var drops = await DropsOf(mod);

        Assert.Equal(expected.Order(), drops.Select(drop => (drop.Record.FormKey, drop.Field)).Order());
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
    public async Task DropsIn_OfADeletedCompressedCell_AnswersThatThePluginWrittenDoesNotReadBack_NamingTheCell()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { MajorRecordFlagsRaw = (int)DeletedFlag.Bit, IsCompressed = true };
        mod.AddInteriorCells(cell);

        var unread = (await DropsAnswerOf(mod)).Failure();

        Assert.StartsWith($"Cell {cell.FormKey} — ", unread.Reason, StringComparison.Ordinal);
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

    private static async Task<IReadOnlyList<DroppedValue>> DropsOf(Fallout4Mod mod) => (await DropsAnswerOf(mod)).Answered();

    private static async Task<Answer<IReadOnlyList<DroppedValue>, PluginFailure>> DropsAnswerOf(Fallout4Mod mod)
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
