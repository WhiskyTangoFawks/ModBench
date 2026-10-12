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

public sealed class RecordTextCodecRefusalTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    private static readonly Dictionary<string, string> RecordTypeOfGroupFolder = new() { ["Weapons"] = "weap", ["Globals"] = "glob" };

    private static string WeaponText()
    {
        var weapon = new Weapon(new FormKey(ModKey.FromFileName("Refusal.esp"), 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "Gun",
            Name = "A gun",
            Weight = 2.5f,
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

        Assert.NotNull(Why(text[..(text.Length / 2)]));
    }

    [Fact]
    public void TextAfterTheClosingBrace_IsRefused()
    {
        Assert.NotNull(Why(WeaponText() + "\n{}"));
    }

    [Fact]
    public void AMalformedFormKey_IsRefused_WithTheReadersWords()
    {
        var why = Why(Edited(WeaponText(), root => root["FormKey"] = "not a form key"));

        Assert.False(string.IsNullOrWhiteSpace(why));
    }

    [Fact]
    public async Task EveryDocumentOfAFreshlyDecompiledPlugin_IsARecord_TheHeaderAWeaponAGlobalAWorldspaceAndTwoCells()
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
        using var folder = new ScratchDirectory("medit-refusal-tree-");
        await Fallout4WholeMod.Serialize(mod, folder.Path);

        var checkedFiles = 0;
        var refused = new List<string>();
        foreach (var file in Directory.EnumerateFiles(folder.Path, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(folder.Path, file).Replace('\\', '/');
            if (RecordTypeOf(relative) is not { } recordType) continue;
            checkedFiles++;
            if (RecordTextCodec.WhyNotARecord(await File.ReadAllTextAsync(file), Release, recordType) is { } why)
                refused.Add($"{relative}: {why}");
        }

        Assert.Empty(refused);
        Assert.Equal(6, checkedFiles);
    }

    private static string? RecordTypeOf(string relative)
    {
        if (relative.EndsWith("GroupRecordData.json", StringComparison.Ordinal)) return null;
        if (relative == DocumentFileNames.Root) return PluginHeader.RecordType;
        if (relative.StartsWith("Worldspaces/", StringComparison.Ordinal) && relative.Count(c => c == '/') == 2) return "wrld";
        if (relative.EndsWith("/" + DocumentFileNames.Root, StringComparison.Ordinal)) return "cell";
        return RecordTypeOfGroupFolder[relative.Split('/')[0]];
    }
}
