using System.Text;
using System.Text.RegularExpressions;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
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

    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private const string TheAdaptersOwnScratchPrefix = "medit-readtree-";

    [Fact]
    public async Task ReadTree_OfAFileItCannotWrite_Throws_AndLeavesNoScratchFolderBehind()
    {
        var unwritable = new TreeFile(Path.Combine("Tree.esp", new string('n', 300) + ".json"), "{}"u8.ToArray());

        var thrown = await Assert.ThrowsAnyAsync<IOException>(
            () => Adapter.ReadTreeAsync([unwritable], Codec, GameRelease.Fallout4));

        AssertScratchFolderGone(thrown.Message);
    }

    [Fact]
    public async Task ReadTree_OfASourceItCannotRead_AnswersTheDiagnosis_AndLeavesNoScratchFolderBehind()
    {
        var unreadable = new TreeFile(Path.Combine("Tree.esp", "RecordData.json"), "{ not json"u8.ToArray());

        var (tree, diagnosis, error) = await Adapter.ReadTreeAsync([unreadable], Codec, GameRelease.Fallout4);

        Assert.Null(tree);
        Assert.NotNull(diagnosis);
        AssertScratchFolderGone(Assert.IsAssignableFrom<FilePathedException>(error).Path);
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

        var (_, _, error) = await Adapter.ReadTreeAsync([.. corrupt], Codec, GameRelease.Fallout4);

        AssertScratchFolderGone(Assert.IsType<FilePathedException>(error).Path);
    }

    private static async Task<IReadOnlyList<TreeFile>> ReadTreeFiles(PluginFixtureData data, string pluginName)
    {
        var (files, _) = await Adapter.ReadSourceAsync(
            new ModPath(Path.Combine(data.DataFolder, pluginName)), pluginName, GameRelease.Fallout4,
            new PluginStrings(null, data.DataFolder));
        return files;
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

        await Adapter.WriteFromTreeAsync(files, recompiledPath, reversed);

        var written = Adapter.ReadContent(
            new ModPath(ModKey.FromFileName("Patch.esp"), recompiledPath), GameRelease.Fallout4);
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

        await Adapter.WriteFromTreeAsync(files, recompiledPath, ["AlphaBase.esm"]);

        var written = Adapter.ReadContent(
            new ModPath(ModKey.FromFileName("Lower.esp"), recompiledPath), GameRelease.Fallout4);
        Assert.Equal(["AlphaBase.esm"], written.Content.Masters);
    }
}
