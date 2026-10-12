using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
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

    [Fact]
    public void ADocumentTheCodecWroteIsARecord()
    {
        Assert.Null(Why(WeaponText()));
    }

    [Fact]
    public void ADocumentReformattedAndReordered_IsStillTheRecord()
    {
        var reordered = Edited(WeaponText(), root =>
        {
            var value = root["EditorID"];
            _ = root.Remove("EditorID");
            root["EditorID"] = value;
        });

        Assert.Null(Why(reordered));
    }

    [Fact]
    public void AMisspelledField_IsRefused_NamingIt()
    {
        var misspelled = Edited(WeaponText(), root =>
        {
            var value = root["EditorID"];
            _ = root.Remove("EditorID");
            root["EditorId"] = value;
        });

        Assert.Contains("EditorId", Why(misspelled), StringComparison.Ordinal);
    }

    [Fact]
    public void AValueOfAnotherJsonTypeThanTheCodecWrites_IsRefused_NamingTheField()
    {
        var quoted = Edited(WeaponText(), root => root["Weight"] = "2.5");

        Assert.Contains("Weight", Why(quoted), StringComparison.Ordinal);
    }

    [Fact]
    public void ANumberWhereATranslatedStringBelongs_IsRefused()
    {
        Assert.NotNull(Why(Edited(WeaponText(), root => root["Name"] = 5)));
    }

    [Fact]
    public void AnUnknownField_IsRefused_NamingIt()
    {
        Assert.Contains("Bogus", Why(Edited(WeaponText(), root => root["Bogus"] = 1)), StringComparison.Ordinal);
    }

    [Fact]
    public void AFieldLeftOut_IsTheRecordWithThatFieldAtItsDefault()
    {
        Assert.Null(Why(Edited(WeaponText(), root => root.Remove("Name"))));
    }

    [Fact]
    public void ATruncatedDocument_IsRefused()
    {
        var text = WeaponText();

        Assert.StartsWith("Expected end of string, but instead reached end of data", Why(text[..(text.Length / 2)]), StringComparison.Ordinal);
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

        Assert.StartsWith("Weight", why, StringComparison.Ordinal);
        Assert.DoesNotContain("MutagenObjectType", why, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("true")]
    [InlineData("\"not a form key\"")]
    public void ALinkInAListThatIsNoFormKey_IsRefused_NamingTheListAndItsPlace(string link)
    {
        var why = Why(Edited(WeaponText(), root => root["Keywords"] = new JsonArray(JsonNode.Parse(link))));

        Assert.StartsWith("Keywords[0]", why, StringComparison.Ordinal);
        Assert.DoesNotContain("MutagenObjectType", why, StringComparison.Ordinal);
    }

    [Fact]
    public void AMalformedFormKey_IsRefused_NamingTheField()
    {
        Assert.StartsWith("FormKey", Why(Edited(WeaponText(), root => root["FormKey"] = "not a form key")), StringComparison.Ordinal);
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
    public void AFloatSpelledWithMoreDigitsThanItsPrecision_IsTheSameRecord()
    {
        Assert.Null(Why(Edited(WeaponText(), root => root["Weight"] = JsonNode.Parse("2.5000000000001"))));
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
