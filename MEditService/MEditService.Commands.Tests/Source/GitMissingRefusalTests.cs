using System.Text.Json;
using MEditService.Commands.Build;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Source;

public delegate Task<(string Refusal, string Message)> RunGesture(IServiceProvider services, SourceEditFixture mod, bool force);

public sealed record Gesture(string Name, RunGesture Run)
{
    public override string ToString() => Name;
}

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class GitMissingRefusalTests : IDisposable
{
    private static readonly Gesture Delete = new("delete", (services, mod, _) => Whole(services.GetRequiredService<DeleteRecordChangesHandler>()
        .DeleteRecords([new RecordAt(mod.Plugin, mod.Npc.ToString()), new RecordAt(mod.Plugin, mod.OtherNpc.ToString())])));

    private static readonly Gesture Copy = new("copy", (services, mod, _) => Whole(services.GetRequiredService<CopyRecordChangesHandler>()
        .CopyRecords([new RecordAt(mod.Plugin, mod.Npc.ToString())], CopyMode.New, [mod.Plugin], replace: false)));

    private static readonly Gesture Decompile = new("decompile", (services, mod, force) => Whole(services.GetRequiredService<DecompilePluginHandler>()
        .DecompileAsync([mod.Plugin], force)));

    private static readonly Gesture DecompileAndCommit = new("decompile-and-commit", (services, mod, _) =>
        Whole(services.GetRequiredService<DecompileAndCommitModHandler>().DecompileAndCommitAsync(ToDecompileAndCommit.In(null, SourceEditFixture.ModFolderOrigin))));

    private static readonly Gesture Compile = new("compile", (services, mod, _) => Whole(services.GetRequiredService<CompilePluginHandler>()
        .CompileAsync([mod.Plugin])));

    private static readonly Gesture DecompileAndRepair = new("decompile-and-repair", (services, mod, force) =>
        Whole(services.GetRequiredService<DecompileAndRepairPluginHandler>()
            .DecompileAndRepairAsync([new PluginToRepair(mod.Plugin, "hash", mod.ModFolder)], [], force, agreedDrops: false)));

    private static readonly Gesture Build = new("build", (services, mod, _) => Whole(services.GetRequiredService<BuildModHandler>().BuildAsync(
        [new ModToBuild(SourceEditFixture.ModFolderOrigin, mod.ModFolder, mod.ModFolder, [], null, IsSubmodule: false)],
        new InstanceToBuild("", null, Path.Combine(mod.DataFolder, "stat-cache")))));

    private static readonly Gesture Edit = new("edit", (services, mod, _) => Task.FromResult(Single(
        services.GetRequiredService<EditRecordChangesHandler>()
            .Changes(mod.Plugin, mod.Npc.ToString(), SetAt(JsonDocument.Parse("0.75").RootElement, Member("HeightMax"))).AsResult())));

    private static readonly Gesture Create = new("create", (services, mod, _) => Task.FromResult(Single(
        services.GetRequiredService<CreateRecordChangesHandler>().CreateRecord(mod.Plugin, "npc_").AsResult())));

    private static readonly Gesture RenameSource = new("rename-source", (services, mod, _) => Task.FromResult(
        services.GetRequiredService<RenameSourceChangesHandler>().RenameSource(mod.Plugin, "Renamed.esp")
            .Match(_ => ("Landed", ""), (refusal, message) => (refusal.ToString(), message))));

    public static TheoryData<Gesture> Every { get; } = [Delete, Copy, Decompile, DecompileAndCommit, Compile, DecompileAndRepair, Build, Edit, Create, RenameSource];

    public static TheoryData<Gesture> ThatWriteWhenTheSourceHoldsChanges { get; } = [Decompile, Compile];

    private readonly SourceEditFixture _mod = SourceEditFixture.CompiledPlugin();
    private readonly IServiceProvider _services;

    public GitMissingRefusalTests() =>
        _services = TestEditService.Over(_mod.Holder, source: new GitGoneSourceAdapter());

    public void Dispose() => _mod.Dispose();

    private static async Task<(string Refusal, string Message)> Whole<T, TRefusal>(Task<Answer<T, SelectionRefusal<TRefusal>>> answered)
        where TRefusal : struct, Enum =>
        (await answered).Holds(out _, out var whole) ? ("Landed", "") : (whole.Refusal.ToString(), whole.Message);

    private static (string Refusal, string Message) Single(RecordEditResult result) => (result.Refusal.ToString(), result.Message);

    private SortedDictionary<string, string> FilesOutsideGit() =>
        new(Directory.EnumerateFiles(_mod.ModFolder, "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(_mod.ModFolder, file))
            .Where(relative => !relative.StartsWith(".git" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .ToDictionary(relative => relative, relative => Convert.ToBase64String(File.ReadAllBytes(Path.Combine(_mod.ModFolder, relative)))),
            StringComparer.Ordinal);

    [Theory]
    [MemberData(nameof(Every))]
    public async Task AGestureWithGitMissing_IsRefusedAsGitUnavailable_NamingPath(Gesture gesture)
    {
        var (refusal, message) = await gesture.Run(_services, _mod, false);

        Assert.Equal("GitUnavailable", refusal);
        Assert.Contains("PATH", message, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(ThatWriteWhenTheSourceHoldsChanges))]
    public async Task AGestureThatWrites_WithGitMissing_ChangesNoFile(Gesture gesture)
    {
        SourceEdits.Rewrite<Npc>(_mod.Repository.Require(), _mod.Plugin, _mod.NpcIdentity, GameRelease.Fallout4, npc => npc.HeightMax = 9);
        var before = FilesOutsideGit();

        await gesture.Run(_services, _mod, true);

        Assert.Equal(before, FilesOutsideGit());
    }
}
