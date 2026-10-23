using System.Text.Json;
using MEditService.Commands.Build;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Microsoft.Extensions.DependencyInjection;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class GitMissingRefusalTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.CompiledPlugin();
    private readonly IServiceProvider _services;

    public GitMissingRefusalTests() =>
        _services = TestEditService.Over(_mod.Holder, source: new GitGoneSourceAdapter());

    public void Dispose() => _mod.Dispose();

    private T Handler<T>() where T : notnull => _services.GetRequiredService<T>();

    private static (string Refusal, string Message) WholeSelection<T, TRefusal>(Answer<T, SelectionRefusal<TRefusal>> answer)
        where TRefusal : struct, Enum
    {
        return answer.Holds(out _, out var whole) ? ("Landed", "") : (whole.Refusal.ToString(), whole.Message);
    }

    private static (string Refusal, string Message) Single(RecordEditResult result) => (result.Refusal.ToString(), result.Message);

    private async Task<(string Refusal, string Message)> Gesture(string name, bool force = false)
    {
        var npc = new RecordAt(_mod.Plugin, _mod.Npc.ToString());
        var otherNpc = new RecordAt(_mod.Plugin, _mod.OtherNpc.ToString());
        var statCache = Path.Combine(_mod.DataFolder, "stat-cache");
        return name switch
        {
            "delete" => WholeSelection(await Handler<DeleteRecordChangesHandler>().DeleteRecords([npc, otherNpc])),
            "copy" => WholeSelection(await Handler<CopyRecordChangesHandler>().CopyRecords([npc], CopyMode.New, [_mod.Plugin], replace: false)),
            "decompile" => WholeSelection(await Handler<DecompilePluginHandler>().DecompileAsync([_mod.Plugin], force)),
            "compile" => WholeSelection(await Handler<CompilePluginHandler>().CompileAsync([_mod.Plugin])),
            "decompile-and-repair" => WholeSelection(await Handler<DecompileAndRepairPluginHandler>()
                .DecompileAndRepairAsync([new PluginToRepair(_mod.Plugin, "hash", _mod.ModFolder)], [], force)),
            "build" => WholeSelection(await Handler<BuildModHandler>().BuildAsync(
                [new ModToBuild(SourceEditFixture.ModFolderOrigin, _mod.ModFolder, _mod.ModFolder, [], null)], new InstanceToBuild("", null, statCache))),
            "edit" => Single(Handler<EditRecordChangesHandler>()
                .Changes(_mod.Plugin, _mod.Npc.ToString(), SetAt(JsonDocument.Parse("0.75").RootElement, Member("HeightMax"))).AsResult()),
            "create" => Single(Handler<CreateRecordChangesHandler>().CreateRecord(_mod.Plugin, "npc_").AsResult()),
            "rename-source" => Handler<RenameSourceChangesHandler>().RenameSource(_mod.Plugin, "Renamed.esp")
                .Match(_ => ("Landed", ""), (refusal, message) => (refusal.ToString(), message)),
            _ => throw new ArgumentOutOfRangeException(nameof(name), name, "Unknown gesture"),
        };
    }

    private SortedDictionary<string, string> FilesOutsideGit() =>
        new(Directory.EnumerateFiles(_mod.ModFolder, "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(_mod.ModFolder, file))
            .Where(relative => !relative.StartsWith(".git" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .ToDictionary(relative => relative, relative => Convert.ToBase64String(File.ReadAllBytes(Path.Combine(_mod.ModFolder, relative)))),
            StringComparer.Ordinal);

    [Theory]
    [InlineData("delete")]
    [InlineData("copy")]
    [InlineData("decompile")]
    [InlineData("compile")]
    [InlineData("decompile-and-repair")]
    [InlineData("build")]
    [InlineData("edit")]
    [InlineData("create")]
    [InlineData("rename-source")]
    public async Task AGestureWithGitMissing_IsRefusedAsGitUnavailable_NamingPath(string gesture)
    {
        var (refusal, message) = await Gesture(gesture);

        Assert.Equal("GitUnavailable", refusal);
        Assert.Contains("PATH", message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("decompile")]
    [InlineData("compile")]
    public async Task AGestureThatWrites_WithGitMissing_ChangesNoFile(string gesture)
    {
        SourceEdits.Rewrite<Npc>(_mod.Repository.Require(), _mod.Plugin, _mod.NpcIdentity, GameRelease.Fallout4, npc => npc.HeightMax = 9);
        var before = FilesOutsideGit();

        await Gesture(gesture, force: true);

        Assert.Equal(before, FilesOutsideGit());
    }
}
