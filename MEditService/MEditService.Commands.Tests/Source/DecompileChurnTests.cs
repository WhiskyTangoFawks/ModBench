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

    public DecompileChurnTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ChurnFixture.esp"), Fallout4Release.Fallout4);
        var first = mod.Keywords.AddNew("ChurnKeywordA");
        var second = mod.Keywords.AddNew("ChurnKeywordB");
        var third = mod.Keywords.AddNew("ChurnKeywordC");
        mod.Npcs.AddNew("ChurnNpcPlain");
        var tagged = mod.Npcs.AddNew("ChurnNpcTagged");
        tagged.Keywords = [first.ToLink(), second.ToLink(), third.ToLink()];
        _taggedNpc = tagged.FormKey;
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
    public async Task CreateRecord_Compile_Decompile_LeavesAStatusNamingOnlyTheNewRecordsFileAndTheHeader()
    {
        var created = CreateHandler.CreateRecordSync(_plugin, "npc_");
        Assert.True(created.Applied, created.Message);
        var newFile = SourceModTree.DocumentFile(ModFolder, _plugin, created.NewFormKey.Require()).Require();
        var headerFile = SourceModTree.HeaderDocumentFile(ModFolder, _plugin);

        await CompileHandler.CompileLandedAsync(_plugin);
        await Decompile();

        Assert.Equal([$" M {ToGitPath(headerFile)}", $"?? {ToGitPath(newFile)}"], SourceStatus());
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

        var moved = EditHandler.Edit(_plugin, _taggedNpc.ToString(), MoveTo(1, Member("Keywords"), At(0)));
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
