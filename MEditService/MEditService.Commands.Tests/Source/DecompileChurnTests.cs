using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.RealData;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Source;

public sealed class DecompileChurnTests : IDisposable
{
    private static readonly PluginAddress Plugin = new(CutDownPluginFixture.PluginFileName, "FixtureMod");
    private readonly ScratchDirectory _gameDirectory = new("medit-churn-game-");
    private readonly ScratchDirectory _modFolder = new("medit-churn-");
    private readonly LoadOrderHolder _holder = new();

    public DecompileChurnTests()
    {
        CutDownPluginFixture.TrackedInto(_modFolder);
        _holder.Apply(SnapshotPlugins.Snapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            [new LoadOrderEntry(Plugin.Name, Path.Combine(_modFolder, Plugin.Name), Plugin.Origin, Slot: 0, Enabled: true, Winning: true)]));
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _gameDirectory.Dispose();
    }

    [Fact]
    public async Task Decompile_OfAnUnchangedPlugin_LeavesNoStatusEntry_AndMovesNoFilesStamp()
    {
        var stampsBefore = Stamps();

        await Decompile();

        Assert.Empty(SourceStatus());
        Assert.Equal(stampsBefore, Stamps());
    }

    [Fact]
    public async Task CreateRecord_Compile_Decompile_LeavesAStatusNamingOnlyTheNewRecordsFile()
    {
        var created = TestEditService.CreateHandler(_holder).CreateRecord(Plugin, "npc_");
        Assert.True(created.Applied, created.Message);
        var newFile = TrackedTree.DocumentFile(_modFolder, Plugin, created.NewFormKey.Require()).Require();

        await Compile();
        await Decompile();

        Assert.Equal([$"?? {ToGitPath(newFile)}"], SourceStatus());
    }

    [Fact]
    public async Task DeleteRecord_Compile_Decompile_LeavesAStatusNamingOnlyTheDeletedRecordsFile()
    {
        var victim = TreeDocuments.Of(TrackedTree.Repository(_modFolder), Plugin).First(document => document.RecordType == "npc_");
        var victimFile = TrackedTree.DocumentFile(_modFolder, Plugin, victim.FormKey).Require();
        var deleted = TestEditService.DeleteHandler(_holder).DeleteRecordsSync([new RecordAt(Plugin, victim.FormKey)]);
        Assert.Empty(deleted.Refused);

        await Compile();
        await Decompile();

        Assert.Equal([$" D {ToGitPath(victimFile)}"], SourceStatus());
    }

    [Fact]
    public async Task MovingAListElementInsideOneRecord_Compile_Decompile_ReadsAsAReorderOfThatRecordsFileAlone()
    {
        var (document, list) = TreeDocuments.Of(TrackedTree.Repository(_modFolder), Plugin)
            .SelectMany(document => ListsOf(document).Select(list => (document, list)))
            .First();
        var file = TrackedTree.DocumentFile(_modFolder, Plugin, document.FormKey).Require();

        var moved = TestEditService.EditHandler(_holder).Edit(Plugin, document.FormKey, MoveTo(1, Member(list), At(0)));
        Assert.True(moved.Applied, moved.Message);
        await Compile();
        await Decompile();

        Assert.Equal([$" M {ToGitPath(file)}"], SourceStatus());
        var (removed, added) = DiffLines(file);
        Assert.NotEmpty(removed);
        Assert.Equal(removed.Order(StringComparer.Ordinal), added.Order(StringComparer.Ordinal));
    }

    private static IEnumerable<string> ListsOf(SourceDocument document)
    {
        using var json = JsonDocument.Parse(document.Body);
        return [.. json.RootElement.EnumerateObject()
            .Where(property => property.Value is { ValueKind: JsonValueKind.Array } array
                               && array.GetArrayLength() >= 2
                               && array[0].GetRawText() != array[1].GetRawText())
            .Select(property => property.Name)];
    }

    private (string[] Removed, string[] Added) DiffLines(string file)
    {
        var lines = GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "diff", "-U0", "--", ToGitPath(file))
            .Split('\n')
            .Where(line => line.Length > 0 && !line.StartsWith("+++", StringComparison.Ordinal) && !line.StartsWith("---", StringComparison.Ordinal))
            .ToArray();
        return (
            [.. lines.Where(line => line[0] == '-').Select(line => line[1..])],
            [.. lines.Where(line => line[0] == '+').Select(line => line[1..])]);
    }

    private Task Compile() => CompileServices.Over(_holder.Current).CompileOneAsync(Plugin);

    private async Task Decompile()
    {
        var result = await TestEditService.DecompileHandler(_holder).DecompileAsync([Plugin]);
        Assert.Empty(result.Refused);
    }

    private string[] SourceStatus() =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "status", "--porcelain", "-z", "--untracked-files=all", "--",
                PluginSourceRoot.For(Plugin.Name))
            .Split('\0', StringSplitOptions.RemoveEmptyEntries);

    private Dictionary<string, (long Size, DateTime Modified)> Stamps() =>
        Directory.EnumerateFiles(PluginSourceRoot.In(_modFolder, Plugin.Name), "*", SearchOption.AllDirectories)
            .ToDictionary(file => Path.GetRelativePath(_modFolder, file), file => (new FileInfo(file).Length, File.GetLastWriteTimeUtc(file)));

    private static string ToGitPath(string relativePath) => relativePath.Replace('\\', '/');
}
