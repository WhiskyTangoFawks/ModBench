using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Source;

public sealed class DecompileChurnTests : TestInstance
{
    private readonly PluginAddress _plugin;
    private readonly FormKey _taggedNpc;
    private readonly FormKey _rankedNpc;

    public DecompileChurnTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ChurnFixture.esp"), Fallout4Release.Fallout4);
        var first = mod.Packages.AddNew("ChurnPackageA");
        var second = mod.Packages.AddNew("ChurnPackageB");
        var third = mod.Packages.AddNew("ChurnPackageC");
        mod.Npcs.AddNew("ChurnNpcPlain");
        var tagged = mod.Npcs.AddNew("ChurnNpcTagged");
        tagged.Packages.AddRange([first.ToLink(), second.ToLink(), third.ToLink()]);
        _taggedNpc = tagged.FormKey;
        var ranked = mod.Npcs.AddNew("ChurnNpcRanked");
        ranked.Factions.AddRange(
        [
            new RankPlacement { Faction = mod.Factions.AddNew("ChurnFactionA").ToLink(), Rank = 0 },
            new RankPlacement { Faction = mod.Factions.AddNew("ChurnFactionB").ToLink(), Rank = 1 },
        ]);
        _rankedNpc = ranked.FormKey;
        _plugin = Add(mod, "FixtureMod");
    }

    private string ModFolder => ModFolderOf(_plugin);

    [Fact]
    public async Task Decompile_OfAnUnchangedPlugin_LeavesNoStatusEntry()
    {
        await Decompile();

        Assert.Empty(SourceStatus());
    }

    [Fact]
    public async Task CreateRecord_Compile_Decompile_LeavesAStatusNamingOnlyTheNewRecordsFile()
    {
        var created = CreateHandler.CreateRecordSync(_plugin, "npc_");
        Assert.True(created.Applied, created.Message);
        var newFile = SourceModTree.DocumentFile(ModFolder, _plugin, created.NewFormKey.Require()).Require();

        await CompileHandler.CompileLandedAsync(_plugin);
        await Decompile();

        Assert.Equal([$"?? {ToGitPath(newFile)}"], SourceStatus());
    }

    [Fact]
    public async Task ChildrenCreatedInContainersCreated_Compile_Decompile_LeavesEveryCreatedFileAsCreateWroteIt()
    {
        var cell = Created("cell");
        var quest = Created("qust");
        Created("refr", cell);
        var topic = Created("dial", quest);
        var files = new[] { cell, quest, topic }
            .Select(formKey => Path.Combine(ModFolder, SourceModTree.DocumentFile(ModFolder, _plugin, formKey).Require()))
            .ToDictionary(file => file, File.ReadAllText);

        await CompileHandler.CompileLandedAsync(_plugin);
        await Decompile();

        Assert.All(files, written => Assert.Equal(written.Value, File.ReadAllText(written.Key)));
    }

    [Fact]
    public async Task AListTheFormatSorts_LeftOutOfItsOrderByHand_Compiles_AndTheNextDecompileWritesItInTheFormatsOrder()
    {
        var file = Path.Combine(ModFolder, SourceModTree.DocumentFile(ModFolder, _plugin, _rankedNpc.ToString()).Require());
        var decompiled = File.ReadAllText(file);
        File.WriteAllText(file, JsonReversal.WithReversed(decompiled, root => root["Factions"].Require().AsArray()));

        await CompileHandler.CompileLandedAsync(_plugin);
        await Decompile();

        Assert.Equal(decompiled, File.ReadAllText(file));
    }

    private string Created(string recordType, string? container = null)
    {
        var created = CreateHandler.CreateRecordSync(_plugin, recordType, container);
        Assert.True(created.Applied, created.Message);
        return created.NewFormKey.Require();
    }

    [Fact]
    public async Task DeleteRecord_Compile_Decompile_LeavesAStatusNamingOnlyTheDeletedRecordsFile()
    {
        var victimFile = SourceModTree.DocumentFile(ModFolder, _plugin, _taggedNpc.ToString()).Require();
        var deleted = DeleteHandler.DeleteRecordsSync([new RecordAt(_plugin, _taggedNpc.ToString())]);
        Assert.Empty(deleted.Refused);

        await CompileHandler.CompileLandedAsync(_plugin);
        await Decompile();

        Assert.Equal([$" D {ToGitPath(victimFile)}"], SourceStatus());
    }

    [Fact]
    public async Task MovingAListElementInsideOneRecord_Compile_Decompile_ReadsAsAReorderOfThatRecordsFileAlone()
    {
        var file = SourceModTree.DocumentFile(ModFolder, _plugin, _taggedNpc.ToString()).Require();

        var moved = EditHandler.Edit(_plugin, _taggedNpc.ToString(), MoveTo(1, Member("Packages"), At(0)));
        Assert.True(moved.Applied, moved.Message);
        await CompileHandler.CompileLandedAsync(_plugin);
        await Decompile();

        Assert.Equal([$" M {ToGitPath(file)}"], SourceStatus());
        var (removed, added) = DiffLines(file);
        Assert.NotEmpty(removed);
        Assert.Equal(removed.Order(StringComparer.Ordinal), added.Order(StringComparer.Ordinal));
    }

    private (string[] Removed, string[] Added) DiffLines(string file)
    {
        var lines = GitProbe.Run(Path.Combine(ModFolder, ".git"), ModFolder, "diff", "-U0", "--", ToGitPath(file))
            .Split('\n')
            .Where(line => line.Length > 0 && !line.StartsWith("+++", StringComparison.Ordinal) && !line.StartsWith("---", StringComparison.Ordinal))
            .ToArray();
        return (
            [.. lines.Where(line => line[0] == '-').Select(line => line[1..])],
            [.. lines.Where(line => line[0] == '+').Select(line => line[1..])]);
    }

    private async Task Decompile()
    {
        var result = await TestEditService.DecompileHandler(Holder).DecompileAsync([_plugin], force: true);
        Assert.Empty(result.Value().Refused);
    }

    private string[] SourceStatus() =>
        GitProbe.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain", "-z", "--untracked-files=all", "--",
                PluginSourceRoot.For(_plugin.Name))
            .Split('\0', StringSplitOptions.RemoveEmptyEntries);

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');
}
