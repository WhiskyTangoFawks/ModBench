using System.Text;
using System.Text.RegularExpressions;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Exceptions;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginTreeReadTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();


    private const string TheAdaptersOwnScratchPrefix = "medit-readtree-";

    [Fact]
    public async Task ReadTree_OfAFileItCannotWrite_Throws_AndLeavesNoScratchFolderBehind()
    {
        var unwritable = new TreeFile(Path.Combine("Tree.esp", new string('n', 300) + ".json"), "{}"u8.ToArray());

        var thrown = await Assert.ThrowsAnyAsync<IOException>(
            () => Adapter.ReadTreeAsync([unwritable], EmptyLoadOrder.Of(GameRelease.Fallout4)));

        AssertScratchFolderGone(thrown.Message);
    }

    [Fact]
    public async Task ReadTree_OfASourceItCannotRead_AnswersTheDiagnosis()
    {
        var unreadable = new TreeFile(Path.Combine("Tree.esp", "RecordData.json"), "{ not json"u8.ToArray());

        var read = await Adapter.ReadTreeAsync([unreadable], EmptyLoadOrder.Of(GameRelease.Fallout4));

        Assert.IsType<PluginFailure.Unparsed>(read.Failure());
    }

    [Fact]
    public async Task ReadTree_OfAHeaderThatNamesAnotherGame_AnswersTheDiagnosisAtTheHeadersFile()
    {
        var skyrim = new TreeFile(Path.Combine("Tree.esp", "RecordData.json"), "{ \"ModKey\": \"Tree.esp\", \"GameRelease\": \"SkyrimSE\" }"u8.ToArray());

        var read = await Adapter.ReadTreeAsync([skyrim], EmptyLoadOrder.Of(GameRelease.Fallout4));

        Assert.Equal(Path.Combine("Tree.esp", "RecordData.json"), Assert.IsType<PluginFailure.Unparsed>(read.Failure()).Diagnosis.Anchor);
    }

    [Fact]
    public async Task ReadTree_ForAGameWithNoRegisteredCodec_Throws_RatherThanBlamingTheSource()
    {
        var header = new TreeFile(Path.Combine("Tree.esp", "RecordData.json"), "{ \"ModKey\": \"Tree.esp\" }"u8.ToArray());

        await Assert.ThrowsAsync<NotSupportedException>(() => Adapter.ReadTreeAsync([header], EmptyLoadOrder.Of(GameRelease.Oblivion)));
    }

    [Fact]
    public async Task ReadTree_OfAMalformedFormKey_ReadsInAScratchFolder_AndRemovesIt()
    {
        var race = string.Empty;
        using var data = new PluginFixtureBuilder("readtree-scratch")
            .WithPlugin("Tree.esp", mod =>
            {
                var treeRace = mod.Races.AddNew("TreeRace");
                race = treeRace.FormKey.ToString();
                mod.Npcs.AddNew("TreeNpc").Race.SetTo(treeRace);
            })
            .Build();
        var files = await ReadTreeFiles(data, "Tree.esp");
        var corrupt = files.Select(file => new TreeFile(file.RelativePath,
            Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(file.Content).Replace(race, "NOT-A-FORMKEY", StringComparison.Ordinal))));

        var read = await Adapter.ReadTreeAsync([.. corrupt], EmptyLoadOrder.Of(GameRelease.Fallout4));

        AssertScratchFolderGone(Assert.IsType<FilePathedException>(read.Failure().Error).Path);
    }

    private static async Task<IReadOnlyList<TreeFile>> ReadTreeFiles(PluginFixtureData data, string pluginName)
    {
        var read = await Adapter.ReadSourceOfAsync(
            new RegisteredPlugin(
                pluginName, PluginOrigin.DataDirectory, Path.Combine(data.DataFolder, pluginName), PluginProvider.Game, Line: null,
                HandedStrings.Of(Path.Combine(data.DataFolder, pluginName))),
            EmptyLoadOrder.Of(GameRelease.Fallout4));
        return read.Answered().Files;
    }

    private static void AssertScratchFolderGone(string textNamingAPathInIt)
    {
        var scratch = Regex.Match(textNamingAPathInIt, Regex.Escape(Path.GetTempPath()) + TheAdaptersOwnScratchPrefix + @"[^/\\]+").Value;
        Assert.NotEmpty(scratch);
        Assert.False(Directory.Exists(scratch));
    }

    [Fact]
    public async Task WriteFromTree_WithAMasterOrder_WritesTheMasterListInThatOrder()
    {
        using var data = new PluginFixtureBuilder("writetree-masters")
            .WithPlugin("AlphaBase.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("BetaBase.esm", mod => mod.Npcs.AddNew("BetaNpc"))
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                foreach (var npc in built.SelectMany(b => b.Npcs))
                    mod.Npcs.GetOrAddAsOverride(npc);
            })
            .Build();
        var files = await ReadTreeFiles(data, "Patch.esp");
        var reversed = new[] { "BetaBase.esm", "AlphaBase.esm" };
        var recompiledPath = Path.Combine(Directory.CreateDirectory(Path.Combine(data.DataFolder, "scratch")).FullName, "Patch.esp");

        (await Adapter.WriteFromTreeAsync(files, recompiledPath, reversed, EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        var written = Adapter.ReadContent(
            new ModPath(ModKey.FromFileName("Patch.esp"), recompiledPath), EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None).Answered();
        Assert.Equal(reversed, written.Content.Masters);
    }

    [Fact]
    public async Task WriteFromTree_OfANativeFormIdBelowTheHighRange_WithNoMasterItsContentNeeds_KeepsTheFirstOfTheMasterOrderAsItsMaster()
    {
        using var data = new PluginFixtureBuilder("writetree-lower-range")
            .WithPlugin("AlphaBase.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin(
                "Lower.esp",
                mod =>
                {
                    mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("AlphaBase.esm") });
                    mod.Npcs.Add(new Npc(new FormKey(mod.ModKey, 0x700), Fallout4Release.Fallout4) { EditorID = "LowerNpc" });
                },
                writeParams: new BinaryWriteParameters { MastersListContent = MastersListContentOption.NoCheck })
            .Build();
        var files = await ReadTreeFiles(data, "Lower.esp");
        var recompiledPath = Path.Combine(Directory.CreateDirectory(Path.Combine(data.DataFolder, "scratch")).FullName, "Lower.esp");

        (await Adapter.WriteFromTreeAsync(files, recompiledPath, ["AlphaBase.esm"], EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        var written = Adapter.ReadContent(
            new ModPath(ModKey.FromFileName("Lower.esp"), recompiledPath), EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None).Answered();
        Assert.Equal(["AlphaBase.esm"], written.Content.Masters);
    }

    [Fact]
    public async Task WriteFromTree_WritesAGroupsRecordsInTheOrderOfTheirFilesNames()
    {
        var byName = Enumerable.Range(0, 20).Select(i => $"Npc{i:D2}").ToList();
        using var data = new PluginFixtureBuilder("writetree-group-order")
            .WithPlugin("Order.esp", mod =>
            {
                foreach (var editorId in Enumerable.Reverse(byName)) mod.Npcs.AddNew(editorId);
            })
            .Build();
        var files = await ReadTreeFiles(data, "Order.esp");
        var recompiledPath = Path.Combine(Directory.CreateDirectory(Path.Combine(data.DataFolder, "scratch")).FullName, "Order.esp");

        (await Adapter.WriteFromTreeAsync(files, recompiledPath, [], EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        using var written = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Order.esp"), recompiledPath), Fallout4Release.Fallout4);
        Assert.Equal(byName, written.Npcs.Select(npc => npc.EditorID));
    }

    [Fact]
    public async Task WriteFromTree_WritesABlockLevelInTheOrderOfItsFoldersNames()
    {
        var byName = Enumerable.Range(0, 10).ToList();
        using var data = new PluginFixtureBuilder("writetree-block-order")
            .WithPlugin("Blocks.esp", mod =>
            {
                foreach (var number in Enumerable.Reverse(byName))
                {
                    var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
                    subBlock.Cells.Add(new Cell(mod) { EditorID = $"Cell{number}" });
                    var block = new CellBlock { BlockNumber = number, GroupType = GroupTypeEnum.InteriorCellBlock };
                    block.SubBlocks.Add(subBlock);
                    mod.Cells.Records.Add(block);
                }
            })
            .Build();
        var files = await ReadTreeFiles(data, "Blocks.esp");
        var recompiledPath = Path.Combine(Directory.CreateDirectory(Path.Combine(data.DataFolder, "scratch")).FullName, "Blocks.esp");

        (await Adapter.WriteFromTreeAsync(files, recompiledPath, [], EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        using var written = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Blocks.esp"), recompiledPath), Fallout4Release.Fallout4);
        Assert.Equal(byName, written.Cells.Records.Select(block => block.BlockNumber));
    }

    [Fact]
    public async Task WriteFromTree_WritesTheNextObjectIdTheSourceHolds_NotOnePastItsHighestRecord()
    {
        using var data = new PluginFixtureBuilder("writetree-next-object-id")
            .WithPlugin(
                "Counter.esp",
                mod =>
                {
                    mod.Npcs.AddNew("OnlyNpc");
                    mod.ModHeader.Stats.NextFormID = 0x900;
                },
                writeParams: new BinaryWriteParameters { NextFormID = NextFormIDOption.NoCheck })
            .Build();
        var files = await ReadTreeFiles(data, "Counter.esp");
        var recompiledPath = Path.Combine(Directory.CreateDirectory(Path.Combine(data.DataFolder, "scratch")).FullName, "Counter.esp");

        (await Adapter.WriteFromTreeAsync(files, recompiledPath, [], EmptyLoadOrder.Of(GameRelease.Fallout4))).Answered();

        using var written = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Counter.esp"), recompiledPath), Fallout4Release.Fallout4);
        Assert.Equal(0x900u, written.ModHeader.Stats.NextFormID);
    }

    [Fact]
    public async Task WriteFromTree_OfAStarfieldOverrideOfALightMastersRecord_WritesItUnderThatMastersFormKey()
    {
        using var scratch = new ScratchDirectory("writetree-light-master");
        var loadOrder = LightMasterAndChild.LoadOrderIn(scratch);
        var source = (await Adapter.ReadSourceOfAsync(LightMasterAndChild.ChildIn(loadOrder), loadOrder)).Answered();
        var recompiledPath = Path.Combine(Directory.CreateDirectory(Path.Combine(scratch, "recompiled")).FullName, LightMasterAndChild.Child.FileName);

        (await Adapter.WriteFromTreeAsync(source.Files, recompiledPath, source.Masters, loadOrder)).Answered();

        using var written = Adapter.OpenDocuments(
            new ModPath(LightMasterAndChild.Child, recompiledPath), loadOrder, SharedSchemaReflector.Instance.GetSchemas(GameRelease.Starfield), PluginStrings.None).Answered();
        Assert.Equal([LightMasterAndChild.Weapon.ToString()], written.Records.Select(record => record.FormKey));
    }

    [Fact]
    public async Task WriteFromTree_OfAStarfieldTree_WhoseMasterHeaderDoesNotRead_Fails_AndWritesNothing()
    {
        using var scratch = new ScratchDirectory("writetree-unreadable-master");
        var loadOrder = LightMasterAndChild.LoadOrderIn(scratch);
        var source = (await Adapter.ReadSourceOfAsync(LightMasterAndChild.ChildIn(loadOrder), loadOrder)).Answered();
        File.WriteAllBytes(Path.Combine(scratch, LightMasterAndChild.Master.FileName), "not a plugin"u8.ToArray());
        var recompiledPath = Path.Combine(Directory.CreateDirectory(Path.Combine(scratch, "recompiled")).FullName, LightMasterAndChild.Child.FileName);

        var written = await Adapter.WriteFromTreeAsync(source.Files, recompiledPath, source.Masters, loadOrder);

        Assert.False(written.Holds(out _, out _));
        Assert.False(File.Exists(recompiledPath));
    }
}
