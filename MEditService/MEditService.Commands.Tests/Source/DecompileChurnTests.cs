using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Source;

public sealed class DecompileChurnTests : TestInstance
{
    private readonly PluginAddress _plugin;
    private readonly FormKey _npc;

    public DecompileChurnTests()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("ChurnFixture.esp"), Fallout4Release.Fallout4);
        _npc = mod.Npcs.AddNew("ChurnNpc").FormKey;
        _plugin = Add(mod, "FixtureMod");
    }

    private string ModFolder => ModFolderOf(_plugin);

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
    public async Task DeleteRecord_Compile_Decompile_LeavesAStatusNamingOnlyTheDeletedRecordsFile()
    {
        var victimFile = SourceModTree.DocumentFile(ModFolder, _plugin, _npc.ToString()).Require();
        var deleted = DeleteHandler.DeleteRecordsSync([new RecordAt(_plugin, _npc.ToString())]);
        Assert.Empty(deleted.Refused);

        await CompileHandler.CompileLandedAsync(_plugin);
        await Decompile();

        Assert.Equal([$" D {ToGitPath(victimFile)}"], SourceStatus());
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
