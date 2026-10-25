using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordTextCodecRefusalTests : IAsyncLifetime, IDisposable
{
    private readonly ScratchDirectory _tree = new("medit-refusal-tree-");

    private const GameRelease Release = GameRelease.Fallout4;

    private static string WeaponText()
    {
        var weapon = new Weapon(new FormKey(ModKey.FromFileName("Refusal.esp"), 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "Gun",
            Name = "A gun",
            Weight = 2.5f,
            Keywords = [new FormLink<IKeywordGetter>(new FormKey(ModKey.FromFileName("Fallout4.esm"), 0x12))],
        };
        return RecordTextCodec.SerializeToText(weapon, Release);
    }

    private static string Edited(string text, Action<JsonObject> edit)
    {
        var root = JsonNode.Parse(text)?.AsObject() ?? throw new InvalidOperationException("Expected a document's root to be an object.");
        edit(root);
        return root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    private static string? Why(string text) => RecordTextCodec.WhyNotARecord(text, Release, "weap");

    private static readonly Dictionary<string, Action<JsonObject>> Edits = new(StringComparer.Ordinal)
    {
        ["none"] = _ => { },
        ["its members reordered"] = root =>
        {
            var value = root["EditorID"];
            _ = root.Remove("EditorID");
            root["EditorID"] = value;
        },
        ["a field left out"] = root => root.Remove("Name"),
        ["a float spelled with more digits than its precision"] = root => root["Weight"] = JsonNode.Parse("2.5000000000001"),
        ["a field misspelled"] = root =>
        {
            var value = root["EditorID"];
            _ = root.Remove("EditorID");
            root["EditorId"] = value;
        },
        ["a number quoted"] = root => root["Weight"] = "2.5",
        ["an unknown field"] = root => root["Bogus"] = 1,
        ["a malformed FormKey"] = root => root["FormKey"] = "not a form key",
    };

    [Theory]
    [InlineData("none")]
    [InlineData("its members reordered")]
    [InlineData("a field left out")]
    [InlineData("a float spelled with more digits than its precision")]
    public void ADocumentTheCodecWrote_IsStillTheRecord_AfterAnEditThatKeepsItsMeaning(string edit)
    {
        Assert.Null(Why(Edited(WeaponText(), Edits[edit])));
    }

    [Theory]
    [InlineData("a field misspelled", "EditorId")]
    [InlineData("a number quoted", "Weight")]
    [InlineData("an unknown field", "Bogus")]
    [InlineData("a malformed FormKey", "FormKey")]
    public void ADocumentEditedOutOfTheCodecsShape_IsRefused_NamingTheField(string edit, string field)
    {
        Assert.StartsWith(field, Why(Edited(WeaponText(), Edits[edit])), StringComparison.Ordinal);
    }

    private static readonly ModKey Refusal = ModKey.FromFileName("Refusal.esp");

    private static readonly Dictionary<string, (Func<IMajorRecordGetter> Record, string Table)> Holders = new(StringComparer.Ordinal)
    {
        ["an npc"] = (() => new Npc(new FormKey(Refusal, 0x801), Fallout4Release.Fallout4) { EditorID = "Guy" }, "npc_"),
        ["an armor mod"] = (() => new ArmorModification(new FormKey(Refusal, 0x802), Fallout4Release.Fallout4)
        {
            EditorID = "ArmorMod",
            Properties = [new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f }],
        }, "omod"),
        ["a bool game setting"] = (() => new GameSettingBool(new FormKey(Refusal, 0x803), Fallout4Release.Fallout4) { EditorID = "bTest", Data = true }, "gmst"),
        ["a misc item"] = (() => new MiscItem(new FormKey(Refusal, 0x804), Fallout4Release.Fallout4) { EditorID = "Misc", ComponentDisplayIndices = [1] }, "misc"),
        ["a scene collection"] = (() => new SceneCollection(new FormKey(Refusal, 0x805), Fallout4Release.Fallout4) { EditorID = "Scco", XNAMs = [1L] }, "scco"),
        ["a material object"] = (() => new MaterialObject(new FormKey(Refusal, 0x806), Fallout4Release.Fallout4) { EditorID = "Mato", DNAMs = [new MemorySlice<byte>([0x01, 0x02])] }, "mato"),
        ["a race"] = (() => new Race(new FormKey(Refusal, 0x809), Fallout4Release.Fallout4) { EditorID = "Race" }, "race"),
        ["a faction"] = (() => new Faction(new FormKey(Refusal, 0x80A), Fallout4Release.Fallout4)
        {
            EditorID = "Faction",
            VendorLocation = new LocationTargetRadius { Radius = 1, Target = new LocationFallback() },
        }, "fact"),
    };

    [Theory]
    [InlineData("an npc", "Flags", "\"NotANumber\"")]
    [InlineData("an npc", "Aggression", "\"NotARealAggressionLevel\"")]
    [InlineData("an npc", "Race", "\"not-a-formkey\"")]
    [InlineData("an npc", "Voice", "42")]
    [InlineData("an npc", "Keywords", "\"000801:Refusal.esp\"")]
    [InlineData("an npc", "Weight", "0.5")]
    [InlineData("an npc", "Weight", """{"Thin":"not-a-number","Fat":0.5,"Muscular":0.3}""")]
    [InlineData("an npc", "HeightMax", "\"tall\"")]
    [InlineData("an npc", "EnergyLevel", "256")]
    [InlineData("an npc", "XpValueOffset", "32768")]
    [InlineData("an npc", "AggroRadiusWarn", "-1")]
    [InlineData("an armor mod", "Properties", "99")]
    [InlineData("an armor mod", "Properties", """[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":"not-a-number","Value2":7,"FunctionType":"Set"}]""")]
    [InlineData("a bool game setting", "Data", "2.5")]
    [InlineData("a misc item", "ComponentDisplayIndices", "[3, 4096]")]
    [InlineData("a misc item", "ComponentDisplayIndices", """[3, "nope"]""")]
    [InlineData("a scene collection", "XNAMs", "[7, 9223372036854775808]")]
    [InlineData("a material object", "DNAMs", """["0xAAZZ"]""")]
    [InlineData("a race", "Subgraphs", """[{"Role": "MT", "AnimationPaths": [{"nope": 1}]}, {"Role": "Weapon"}]""")]
    [InlineData("a faction", "VendorLocation", """{"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": "not-a-number"}}""")]
    public void AValueTheMembersTypeCannotHold_IsRefused_NamingTheMember(string holder, string member, string value)
    {
        var (record, table) = Holders[holder];

        var why = RecordTextCodec.WhyNotARecord(Edited(RecordTextCodec.SerializeToText(record(), Release), root => root[member] = JsonNode.Parse(value)), Release, table);

        Assert.StartsWith(member, why, StringComparison.Ordinal);
    }

    [Fact]
    public void ANumberWhereATranslatedStringBelongs_IsRefused()
    {
        Assert.Equal("Name holds a value of the wrong type.", Why(Edited(WeaponText(), root => root["Name"] = 5)));
    }

    private static readonly Dictionary<string, Func<string>> DocumentsOf = new(StringComparer.Ordinal)
    {
        ["weap"] = WeaponText,
        [PluginHeader.RecordType] = () => Encoding.UTF8.GetString(HeaderDocument.Write(new Fallout4Mod(ModKey.FromFileName("Fresh.esp"), Fallout4Release.Fallout4))),
    };

    [Theory]
    [InlineData("weap")]
    [InlineData(PluginHeader.RecordType)]
    public void ATruncatedDocument_IsRefused_WhereTheReaderStopped(string recordType)
    {
        var text = DocumentsOf[recordType]();

        Assert.StartsWith("Expected end of string, but instead reached end of data", RecordTextCodec.WhyNotARecord(text[..(text.Length / 2)], Release, recordType), StringComparison.Ordinal);
    }

    [Fact]
    public void TextAfterTheClosingBrace_IsRefused()
    {
        Assert.Contains("is invalid after a single JSON value", Why(WeaponText() + "\n{}"), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("true")]
    [InlineData("null")]
    [InlineData("{}")]
    public void AWeightOfTheWrongTypeOrNull_IsRefused_NamingTheField_NotTheRecordType(string weight)
    {
        var why = Why(Edited(WeaponText(), root => root["Weight"] = JsonNode.Parse(weight)));

        Assert.Equal("Weight holds a value of the wrong type.", why);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("true")]
    [InlineData("\"not a form key\"")]
    public void ALinkInAListThatIsNoFormKey_IsRefused_NamingTheListAndItsPlace(string link)
    {
        var why = Why(Edited(WeaponText(), root => root["Keywords"] = new JsonArray(JsonNode.Parse(link))));

        Assert.StartsWith("Keywords[0]", why, StringComparison.Ordinal);
    }

    [Fact]
    public void TwoFieldsOfTheWrongType_AreRefused_NamingBoth()
    {
        var why = Why(Edited(WeaponText(), root =>
        {
            root["Weight"] = true;
            root["Keywords"] = new JsonArray(true);
        }));

        Assert.Equal("Keywords[0]: Unable to cast object of type 'System.Boolean' to type 'System.String'.; Weight holds a value of the wrong type.", why);
    }

    [Fact]
    public void ACellWhoseChildSlotHoldsNoChild_IsTheCellWithTheSlotLeftOut()
    {
        var cell = RecordTextCodec.SerializeToText(
            new Cell(new FormKey(ModKey.FromFileName("Refusal.esp"), 0x801), Fallout4Release.Fallout4) { EditorID = "Room" },
            Release);

        Assert.Null(RecordTextCodec.WhyNotARecord(Edited(cell, root => root["Persistent"] = new JsonArray()), Release, "cell"));
    }

    [Fact]
    public void ABlockLevelDocumentTheCodecWrote_IsTheLevel()
    {
        var level = RecordTypes.For(Release).InteriorCellBlockLevels[0];
        var document = RecordTextCodec.BlankDocument(level, Release, Document.Empty.With(3, RecordTypes.BlockNumberMember));

        Assert.Null(RecordTextCodec.WhyNotABlockLevel(document, Release, level));
    }

    [Fact]
    public void ABlockLevelDocumentWithAValueOfTheWrongType_IsRefused_NamingTheField()
    {
        var level = RecordTypes.For(Release).InteriorCellBlockLevels[0];
        var document = RecordTextCodec.BlankDocument(level, Release, Document.Empty.With(3, RecordTypes.BlockNumberMember));

        Assert.StartsWith("BlockNumber", RecordTextCodec.WhyNotABlockLevel(Edited(document, root => root["BlockNumber"] = "text"), Release, level), StringComparison.Ordinal);
    }

    [Fact]
    public void ABlockLevelDocumentWithAnUnknownField_IsRefused_NamingIt()
    {
        var level = RecordTypes.For(Release).InteriorCellBlockLevels[0];
        var document = RecordTextCodec.BlankDocument(level, Release, Document.Empty.With(3, RecordTypes.BlockNumberMember));

        Assert.Contains("Bogus", RecordTextCodec.WhyNotABlockLevel(Edited(document, root => root["Bogus"] = 1), Release, level), StringComparison.Ordinal);
    }

    [Fact]
    public void AnEnumValueThatDoesNotExist_IsRefused_NamingTheField()
    {
        var cell = RecordTextCodec.SerializeToText(
            new Cell(new FormKey(ModKey.FromFileName("Refusal.esp"), 0x801), Fallout4Release.Fallout4) { Flags = Cell.Flag.IsInteriorCell },
            Release);

        var why = RecordTextCodec.WhyNotARecord(Edited(cell, root => root["Flags"] = new JsonArray("NoSuchFlag")), Release, "cell");

        Assert.StartsWith("Flags", why, StringComparison.Ordinal);
    }

    [Fact]
    public void ASyntaxError_IsRefused_WithItsLineAndPosition()
    {
        var why = Why(WeaponText().Replace("\"Weight\"", "\"Weight\" 1 ", StringComparison.Ordinal));

        Assert.Contains("LineNumber", why, StringComparison.Ordinal);
    }

    [Fact]
    public void AHeaderWithAValueOfTheWrongType_IsRefused_NamingTheMember()
    {
        var header = Encoding.UTF8.GetString(HeaderDocument.Write(new Fallout4Mod(ModKey.FromFileName("Fresh.esp"), Fallout4Release.Fallout4)));

        Assert.Equal("ModHeader.Stats.Version: The input string 'x' was not in a correct format.", RecordTextCodec.WhyNotARecord(Edited(header, root => root["ModHeader"].Require()["Stats"].Require()["Version"] = "x"), Release, PluginHeader.RecordType));
    }

    [Theory]
    [InlineData("RecordData.json", PluginHeader.RecordType)]
    [InlineData("Weapons/Gun - 000800_Fresh.esp.json", "weap")]
    [InlineData("Globals/Gl - 000801_Fresh.esp.json", "glob")]
    [InlineData("Worldspaces/Wrld - 000802_Fresh.esp/RecordData.json", "wrld")]
    [InlineData("Worldspaces/Wrld - 000802_Fresh.esp/0, 0/0, 0/Outside - 000804_Fresh.esp/RecordData.json", "cell")]
    [InlineData("Cells/0/0/Inside - 000805_Fresh.esp/RecordData.json", "cell")]
    public async Task EveryDocumentOfAFreshlyDecompiledPlugin_IsARecord(string relativePath, string recordType)
    {
        var text = await File.ReadAllTextAsync(Path.Combine(_tree.Path, relativePath));

        Assert.Null(RecordTextCodec.WhyNotARecord(text, Release, recordType));
    }

    public async Task InitializeAsync()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fresh.esp"), Fallout4Release.Fallout4);
        mod.Weapons.AddNew().EditorID = "Gun";
        mod.Globals.Add(new GlobalFloat(mod) { EditorID = "Gl", Data = 2.5f });
        var worldspace = new Worldspace(mod) { EditorID = "Wrld", TopCell = new Cell(mod) { EditorID = "Top" } };
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0, GroupType = GroupTypeEnum.ExteriorCellSubBlock };
        subBlock.Items.Add(new Cell(mod) { EditorID = "Outside", Grid = new CellGrid { Point = new P2Int(1, 2) } });
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0, GroupType = GroupTypeEnum.ExteriorCellBlock };
        block.Items.Add(subBlock);
        worldspace.SubCells.Add(block);
        mod.Worldspaces.Add(worldspace);
        var inside = new Cell(mod) { EditorID = "Inside" };
        inside.Temporary.Add(new PlacedObject(mod) { EditorID = "Ref" });
        mod.AddInteriorCells(inside);
        await Fallout4WholeMod.Serialize(mod, _tree.Path);
    }

    public Task DisposeAsync() => Task.CompletedTask;

    public void Dispose() => _tree.Dispose();
}
