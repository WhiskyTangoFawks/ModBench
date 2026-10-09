using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginAdapterTests
{
    private const string PluginName = "Adapter.esp";

    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static PluginFixtureData TwoNpcPlugin(string prefix) =>
        new PluginFixtureBuilder(prefix)
            .WithPlugin(PluginName, mod =>
            {
                mod.Npcs.AddNew("AdapterNpc01");
                mod.Npcs.AddNew("AdapterNpc02");
            })
            .Build();

    private static ModPath PathOf(PluginFixtureData data) =>
        new(ModKey.FromFileName(PluginName), Path.Combine(data.DataFolder, PluginName));

    private static string EditorIdOf(string documentText) =>
        JsonDocument.Parse(documentText).RootElement.GetProperty("EditorID").GetString()
        ?? throw new InvalidOperationException("Expected the document to carry an EditorID.");

    [Fact]
    public void OpenDocuments_ReadsTheRecordsThePluginCarries_UnderTheModKeyItsNameGives()
    {
        using var data = TwoNpcPlugin("adapter-read");

        using var documents = Adapter.OpenDocuments(PathOf(data), GameRelease.Fallout4, Schemas).Answered();
        var npcs = documents.Records.Where(r => r.RecordType == "npc_").ToList();

        Assert.Equal(
            ["AdapterNpc01", "AdapterNpc02"],
            npcs.Select(r => EditorIdOf(r.Text)).Order(StringComparer.Ordinal));
        Assert.All(npcs, r => Assert.EndsWith($":{PluginName}", r.FormKey, StringComparison.Ordinal));
    }

    [Fact]
    public async Task CreateAndWriteAsync_CarriesTheReleaseAndKeyItWasGiven_NoRecordsAndNoMasters()
    {
        using var scratch = new ScratchDirectory("medit-adapter-create-");
        var path = Path.Combine(scratch, PluginName);

        Assert.Equal(
            EmptyPluginWrite.Written,
            (await Adapter.CreateAndWriteAsync(ModKey.FromFileName(PluginName), scratch, GameRelease.Fallout4)).Answered().Outcome);

        using var reread = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(PluginName), path), Fallout4Release.Fallout4);
        Assert.Equal(ModKey.FromFileName(PluginName), reread.ModKey);
        Assert.Equal(GameRelease.Fallout4, reread.GameRelease);
        Assert.Empty(reread.EnumerateMajorRecords());
        Assert.Empty(reread.ModHeader.MasterReferences);
    }

    [Theory]
    [InlineData("Plain.esp", false, false)]
    [InlineData("Master.esm", true, false)]
    [InlineData("Light.esl", false, true)]
    public async Task CreateAndWriteAsync_SetsTheHeaderFlagsFromTheExtensionAlone(string name, bool master, bool light)
    {
        using var scratch = new ScratchDirectory("medit-adapter-create-flags-");
        var path = Path.Combine(scratch, name);

        (await Adapter.CreateAndWriteAsync(ModKey.FromFileName(name), scratch, GameRelease.Fallout4)).Answered();

        using var reread = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(name), path), Fallout4Release.Fallout4);
        Assert.Equal((master, light), (reread.IsMaster, reread.IsSmallMaster));
    }

    [Fact]
    public async Task CreateAndWriteAsync_LeavesThePluginAloneInItsFolder()
    {
        using var scratch = new ScratchDirectory("medit-adapter-create-alone-");
        (await Adapter.CreateAndWriteAsync(ModKey.FromFileName(PluginName), scratch, GameRelease.Fallout4)).Answered();

        Assert.Equal(
            [PluginName],
            Directory.EnumerateFileSystemEntries(scratch, "*", SearchOption.AllDirectories)
                .Select(entry => Path.GetRelativePath(scratch, entry)));
    }

    [Fact]
    public async Task CreateAndWriteAsync_IntoAFolderThatHasGone_AnswersFolderGone_AndMakesNoFolder()
    {
        using var scratch = new ScratchDirectory("medit-adapter-create-gone-");
        var gone = Path.Combine(scratch, "GoneMod");

        var written = await Adapter.CreateAndWriteAsync(ModKey.FromFileName(PluginName), gone, GameRelease.Fallout4);

        Assert.Equal(EmptyPluginWrite.FolderGone, written.Answered().Outcome);
        Assert.False(Directory.Exists(gone));
    }

    [Fact]
    public async Task CreateAndWriteAsync_OverAFileAlreadyThere_AnswersFileExists_AndLeavesItAsItWas()
    {
        using var scratch = new ScratchDirectory("medit-adapter-create-exists-");
        var path = Path.Combine(scratch, PluginName);
        File.WriteAllText(path, "another tool's file");

        var written = await Adapter.CreateAndWriteAsync(ModKey.FromFileName(PluginName), scratch, GameRelease.Fallout4);

        Assert.Equal(EmptyPluginWrite.FileExists, written.Answered().Outcome);
        Assert.Equal("another tool's file", File.ReadAllText(path));
        Assert.Single(Directory.EnumerateFileSystemEntries(scratch));
    }

    [Fact]
    public async Task CreateAndWriteAsync_WhoseMoveLandsOnAnExistingDirectory_LeavesNoTempFile()
    {
        using var scratch = new ScratchDirectory("medit-adapter-create-fails-");
        var directoryAtThePluginsOwnNameBlockingTheMoveOnEveryOs = Directory.CreateDirectory(Path.Combine(scratch, PluginName));

        var written = await Adapter.CreateAndWriteAsync(ModKey.FromFileName(PluginName), scratch, GameRelease.Fallout4);

        Assert.IsType<PluginFailure.Inaccessible>(written.Failure());

        Assert.Equal([PluginName], Directory.EnumerateFileSystemEntries(scratch).Select(Path.GetFileName));
        Assert.Empty(Directory.EnumerateFileSystemEntries(directoryAtThePluginsOwnNameBlockingTheMoveOnEveryOs.FullName));
    }

    [Fact]
    public async Task Commit_WithALoadOrder_WritesTheMasterListInThatOrder()
    {
        using var data = new PluginFixtureBuilder("adapter-masters")
            .WithPlugin("AlphaBase.esm", mod => mod.Npcs.AddNew("AlphaNpc"))
            .WithPlugin("BetaBase.esm", mod => mod.Npcs.AddNew("BetaNpc"))
            .WithPlugin("Patch.esp", (mod, built) =>
            {
                foreach (var npc in built.SelectMany(b => b.Npcs))
                    mod.Npcs.GetOrAddAsOverride(npc);
            })
            .Build();
        var patchPath = Path.Combine(data.DataFolder, "Patch.esp");
        var reversed = new[] { "BetaBase.esm", "AlphaBase.esm" };

        using (var natural = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Patch.esp"), patchPath), Fallout4Release.Fallout4))
        {
            Assert.NotEqual(reversed, natural.ModHeader.MasterReferences.Select(m => m.Master.FileName.ToString()));
        }

        await TreeSaves.SaveAsync(patchPath, prep =>
        {
            prep.Commit();
            return true;
        }, reversed);

        using var reread = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Patch.esp"), patchPath), Fallout4Release.Fallout4);
        Assert.Equal(reversed, reread.ModHeader.MasterReferences.Select(m => m.Master.FileName.ToString()));
    }
}
