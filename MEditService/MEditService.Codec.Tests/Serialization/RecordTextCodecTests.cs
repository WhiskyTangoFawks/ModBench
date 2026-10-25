using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

public class RecordTextCodecTests
{
    private static readonly ModKey TestPlugin = ModKey.FromFileName("Test.esp");

    private static readonly Fallout4Mod Mod = new(TestPlugin, Fallout4Release.Fallout4);

    private static Weapon MakeWeapon() =>
        new(new FormKey(TestPlugin, 0x800), Fallout4Release.Fallout4)
        {
            VersionControl = 12345,
            EditorID = "TestWeapon",
            Name = "Test Weapon Name",
            Value = 250,
            Weight = 12.5f,
            BaseDamage = 42,
            Keywords = [new FormLink<IKeywordGetter>(new FormKey(TestPlugin, 0x801))],
            ObjectBounds = new ObjectBounds
            {
                First = new P3Int16(1, 2, 3),
                Second = new P3Int16(4, 5, 6),
            },
        };

    private static Npc MakeNpc() =>
        new(new FormKey(TestPlugin, 0x900), Fallout4Release.Fallout4) { EditorID = "TestNpc", Name = "Test NPC Name" };

    private static Cell MakeCell() =>
        new(new FormKey(TestPlugin, 0x901), Fallout4Release.Fallout4) { EditorID = "TestCell" };

    private static Cell CellHoldingAChildInEverySlot()
    {
        var cell = new Cell(Mod) { EditorID = "TestCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
        cell.Persistent.Add(new PlacedObject(Mod) { EditorID = "PersistentRef" });
        cell.Temporary.Add(new PlacedObject(Mod) { EditorID = "TemporaryRef" });
        cell.NavigationMeshes.Add(new NavigationMesh(Mod));
        cell.Landscape = new Landscape(Mod);
        return cell;
    }

    private static Worldspace WorldspaceHoldingATopCellAndABlock()
    {
        var worldspace = new Worldspace(Mod) { EditorID = "TestWorld", TopCell = new Cell(Mod) { EditorID = "TopCell" } };
        worldspace.SubCells.Add(new WorldspaceBlock());
        return worldspace;
    }

    private static Quest QuestHoldingEveryChild()
    {
        var quest = new Quest(Mod) { EditorID = "TestQuest" };
        quest.DialogBranches.Add(new DialogBranch(Mod));
        var topic = new DialogTopic(Mod);
        topic.Responses.Add(new DialogResponses(Mod));
        quest.DialogTopics.Add(topic);
        quest.Scenes.Add(new Scene(Mod));
        return quest;
    }

    private static DialogTopic TopicHoldingAResponse()
    {
        var topic = new DialogTopic(Mod) { EditorID = "TestDialogTopic" };
        topic.Responses.Add(new DialogResponses(Mod));
        return topic;
    }

    private static readonly Dictionary<string, Func<(GameRelease Release, IMajorRecordGetter Record, string RecordType)>> Records = new(StringComparer.Ordinal)
    {
        ["a weapon"] = () => (GameRelease.Fallout4, MakeWeapon(), "weap"),
        ["an npc"] = () => (GameRelease.Fallout4, MakeNpc(), "npc_"),
        ["a cell under its class's name"] = () => (GameRelease.Fallout4, MakeCell(), "Cell"),
        ["a cell holding a child in every slot"] = () => (GameRelease.Fallout4, CellHoldingAChildInEverySlot(), "Cell"),
        ["a worldspace holding a top cell and a block"] = () => (GameRelease.Fallout4, WorldspaceHoldingATopCellAndABlock(), "wrld"),
        ["a quest holding every child"] = () => (GameRelease.Fallout4, QuestHoldingEveryChild(), "qust"),
        ["a topic holding a response"] = () => (GameRelease.Fallout4, TopicHoldingAResponse(), "dial"),
        ["a Skyrim recipe conditioned on alias 0"] = () => (GameRelease.SkyrimSE, AliasIndexRoundTripTests.RecipeWithAnAliasCondition(0), "cobj"),
        ["a Skyrim recipe conditioned on alias 3"] = () => (GameRelease.SkyrimSE, AliasIndexRoundTripTests.RecipeWithAnAliasCondition(3), "cobj"),
    };

    [Theory]
    [InlineData("a weapon")]
    [InlineData("an npc")]
    [InlineData("a cell under its class's name")]
    [InlineData("a cell holding a child in every slot")]
    [InlineData("a worldspace holding a top cell and a block")]
    [InlineData("a quest holding every child")]
    [InlineData("a topic holding a response")]
    [InlineData("a Skyrim recipe conditioned on alias 0")]
    [InlineData("a Skyrim recipe conditioned on alias 3")]
    public void ARecordsText_ReadsBackUnchanged_FromTheRecordTypeItIsStoredUnder(string record)
    {
        var (release, made, recordType) = Records[record]();
        var text = RecordTextCodec.SerializeToText(made, release);

        Assert.Equal(text, RecordTextCodec.RoundTrip(text, release, recordType));
    }

    private static readonly Dictionary<string, Func<Task<List<(string Path, bool Value)>>>> WholeModReads = new(StringComparer.Ordinal)
    {
        ["a weapon"] = async () =>
        {
            var weapon = MakeWeapon();
            var mod = new Fallout4Mod(TestPlugin, Fallout4Release.Fallout4);
            mod.Weapons.Add(weapon);
            return [.. MaskInspector.Leaves(weapon.GetEqualsMask(await ReadBack.ThroughTheWholeModDoor<IWeaponGetter>(mod, weapon)))];
        },
        ["an npc"] = async () =>
        {
            var npc = MakeNpc();
            var mod = new Fallout4Mod(TestPlugin, Fallout4Release.Fallout4);
            mod.Npcs.Add(npc);
            return [.. MaskInspector.Leaves(npc.GetEqualsMask(await ReadBack.ThroughTheWholeModDoor<INpcGetter>(mod, npc)))];
        },
        ["an interior cell"] = async () =>
        {
            var cell = MakeCell();
            var mod = new Fallout4Mod(TestPlugin, Fallout4Release.Fallout4);
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            mod.Cells.Records.Add(block);
            return [.. MaskInspector.Leaves(cell.GetEqualsMask(await ReadBack.ThroughTheWholeModDoor<ICellGetter>(mod, cell)))];
        },
    };

    [Theory]
    [InlineData("a weapon")]
    [InlineData("an npc")]
    [InlineData("an interior cell")]
    public async Task ARecord_ReadsBackFieldFaithful_ThroughTheWholeModDoor(string record)
    {
        var leaves = await WholeModReads[record]();

        Assert.NotEmpty(leaves);
        Assert.Empty(leaves.Where(l => !l.Value).Select(l => l.Path));
    }

    private static readonly Dictionary<string, Func<IMajorRecordGetter>> RecordClasses = new(StringComparer.Ordinal)
    {
        ["an int game setting"] = () => new GameSettingInt(Mod) { EditorID = "iTest", Data = 42 },
        ["a float game setting"] = () => new GameSettingFloat(Mod) { EditorID = "fTest", Data = 3.5f },
        ["a string game setting"] = () => new GameSettingString(Mod) { EditorID = "sTest", Data = "hello" },
        ["a bool game setting"] = () => new GameSettingBool(Mod) { EditorID = "bTest", Data = true },
        ["an int global"] = () => new GlobalInt(Mod) { EditorID = "TestGlobInt", Data = 7 },
        ["a float global"] = () => new GlobalFloat(Mod) { EditorID = "TestGlobFloat", Data = 1.25f },
        ["a short global"] = () => new GlobalShort(Mod) { EditorID = "TestGlobShort", Data = 3 },
        ["a bool global"] = () => new GlobalBool(Mod) { EditorID = "TestGlobBool", Data = true },
        ["an armor mod"] = () => new ArmorModification(Mod) { EditorID = "ArmorMod", Properties = [new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f }] },
        ["an npc mod"] = () => new NpcModification(Mod) { EditorID = "NpcMod", Properties = [new ObjectModIntProperty<Npc.Property> { Property = Npc.Property.ForcedInventory, Step = 2f }] },
        ["a weapon mod"] = () => new WeaponModification(Mod) { EditorID = "WeaponMod", Properties = [new ObjectModIntProperty<Weapon.Property> { Property = Weapon.Property.AmmoCapacity, Step = 3f }] },
        ["an object mod"] = () => new ObjectModification(Mod) { EditorID = "ObjectMod", Properties = [new ObjectModIntProperty<AObjectModification.NoneProperty> { Step = 4f }] },
        ["an unknown object mod"] = () => new UnknownObjectModification(Mod) { EditorID = "UnknownMod", Properties = [new ObjectModIntProperty<AObjectModification.NoneProperty> { Step = 5f }] },
        ["a damage type of structs"] = () => new DamageType(Mod)
        {
            EditorID = "PlainDamageType",
            DamageTypes = [new DamageTypeItem { ActorValue = new FormLink<IActorValueInformationGetter>(FormKey.Factory("000001:Test.esp")) }],
        },
        ["a damage type of indices"] = () => new DamageTypeIndexed(Mod) { EditorID = "IndexedDamageType", DamageTypes = [7, 11] },
    };

    [Theory]
    [InlineData("an int game setting", "gmst", "Data", "42")]
    [InlineData("a float game setting", "gmst", "Data", "3.5")]
    [InlineData("a string game setting", "gmst", "Data.Value", "\"hello\"")]
    [InlineData("a bool game setting", "gmst", "Data", "true")]
    [InlineData("an int global", "glob", "Data", "7")]
    [InlineData("a float global", "glob", "Data", "1.25")]
    [InlineData("a short global", "glob", "Data", "3")]
    [InlineData("a bool global", "glob", "Data", "true")]
    [InlineData("an armor mod", "omod", "Properties.0.Property", "\"BodyPart\"")]
    [InlineData("an npc mod", "omod", "Properties.0.Property", "\"ForcedInventory\"")]
    [InlineData("a weapon mod", "omod", "Properties.0.Property", "\"AmmoCapacity\"")]
    [InlineData("an object mod", "omod", "Properties.0.Step", "4.0")]
    [InlineData("an unknown object mod", "omod", "Properties.0.Step", "5.0")]
    [InlineData("a damage type of structs", "dmgt", "DamageTypes.0.ActorValue", "\"000001:Test.esp\"")]
    [InlineData("a damage type of indices", "dmgt", "DamageTypes", "[7,11]")]
    public void EachRecordClassOfATable_ReadsBackItsOwnData_ThroughTheTablesOneColumn(string record, string table, string path, string value)
    {
        var made = RecordClasses[record]();

        var read = path.Split('.').Aggregate(
            ReadBack.Of(made, GameRelease.Fallout4, table),
            (node, hop) => int.TryParse(hop, out var index) ? node[index] : node.GetProperty(hop));

        Assert.Equal(made.GetType().Name, ReadBack.Of(made, GameRelease.Fallout4, table).GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString());
        Assert.Equal(value, JsonSerializer.Serialize(read));
    }

    [Fact]
    public async Task AFixedWeapon_IsWrittenAsThePinnedGoldenBytes()
    {
        var actual = Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(MakeWeapon(), GameRelease.Fallout4));

        var golden = await File.ReadAllBytesAsync(
            Path.Combine(AppContext.BaseDirectory, "TestData", "weapon-dispatch-golden.json"));
        Assert.Equal(golden, actual);
    }

    [Fact]
    public void TheSameRecordState_IsWrittenAsTheSameTextEveryTime_WithNoGoldenInTheLoopBecauseAGoldenIsBlindToNonDeterminismThatReproducesTheSameWrongOutputEveryRun()
    {
        var independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself = MakeWeapon();

        var firstText = RecordTextCodec.SerializeToText(MakeWeapon(), GameRelease.Fallout4);
        var secondText = RecordTextCodec.SerializeToText(independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself, GameRelease.Fallout4);

        Assert.Equal(firstText, secondText);
    }

    [Fact]
    public void ATranslatedStringNestedInARecord_CollapsesToItsStringsLanguageValue_AsDoesTheRecordsOwn()
    {
        var weapon = MakeWeapon();
        weapon.Name = new TranslatedString(Language.English,
        [
            new KeyValuePair<Language, string>(Language.English, "Weapon"),
            new KeyValuePair<Language, string>(Language.French, "Arme"),
        ]);
        weapon.ObjectTemplates =
        [
            new ObjectTemplate<Weapon.Property>
            {
                Name = new TranslatedString(Language.English,
                [
                    new KeyValuePair<Language, string>(Language.English, "Mod English"),
                    new KeyValuePair<Language, string>(Language.French, "Modele"),
                ]),
            },
        ];
        var text = RecordTextCodec.SerializeToText(weapon, GameRelease.Fallout4);

        var collapsed = TranslatedStringValues.InLanguage(text, Language.French, GameRelease.Fallout4, "WEAP").Text;

        Assert.Contains("\"Values\"", text, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Values\"", collapsed, StringComparison.Ordinal);
        Assert.Contains("Arme", collapsed, StringComparison.Ordinal);
        Assert.Contains("Modele", collapsed, StringComparison.Ordinal);
        Assert.DoesNotContain("Mod English", collapsed, StringComparison.Ordinal);
    }

    [Fact]
    public void AStringWithNoTextInTheStringsLanguage_IsReportedByItsPath_AndLeftAsItIs()
    {
        var weapon = MakeWeapon();
        weapon.Name = new TranslatedString(Language.English,
        [
            new KeyValuePair<Language, string>(Language.English, "Weapon"),
            new KeyValuePair<Language, string>(Language.German, "Waffe"),
        ]);
        weapon.ObjectTemplates =
        [
            new ObjectTemplate<Weapon.Property>
            {
                Name = new TranslatedString(Language.English,
                [
                    new KeyValuePair<Language, string>(Language.English, "Mod English"),
                    new KeyValuePair<Language, string>(Language.French, "Modele"),
                ]),
            },
        ];
        var text = RecordTextCodec.SerializeToText(weapon, GameRelease.Fallout4);

        var collapsed = TranslatedStringValues.InLanguage(text, Language.French, GameRelease.Fallout4, "WEAP");

        Assert.Equal(["Name"], collapsed.Unresolved);
        Assert.Contains("Weapon", collapsed.Text, StringComparison.Ordinal);
        Assert.Contains("Modele", collapsed.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void ATranslatedStringsLanguages_AreWrittenInLanguageOrder_WhateverOrderTheModelHoldsThem()
    {
        var weapon = MakeWeapon();
        weapon.Name = new TranslatedString(Language.English,
        [
            new KeyValuePair<Language, string>(Language.French, "Arme"),
            new KeyValuePair<Language, string>(Language.English, "Weapon"),
            new KeyValuePair<Language, string>(Language.German, "Waffe"),
        ]);

        using var doc = JsonDocument.Parse(RecordTextCodec.SerializeToText(weapon, GameRelease.Fallout4));

        Assert.Equal(
            ["English", "German", "French"],
            doc.RootElement.GetProperty("Name").GetProperty("Values").EnumerateArray().Select(value => value.GetProperty("Language").GetString()));
    }
}
