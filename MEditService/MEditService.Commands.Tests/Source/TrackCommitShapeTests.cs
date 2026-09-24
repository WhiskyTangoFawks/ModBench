using System.Security.Cryptography;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Source;

/// <summary>What <c>git log</c> on <c>main</c> shows after Track, through the Commands box over a
/// fixture mod folder and real git (ADR-0007 invariants 2 and 6).</summary>
public sealed class TrackCommitShapeTests : IDisposable
{
    private const string ModName = "TwoPluginMod";
    private readonly string _root = Directory.CreateTempSubdirectory("medit-track-shape-").FullName;
    private readonly string _modFolder;
    private readonly string _gameDir;

    public TrackCommitShapeTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;
        _gameDir = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public async Task Track_OfAModWithTwoPlugins_CommitsTheModsOwnFiles_ThenEachPluginOnItsOwn()
    {
        var metaSha256 = WriteMetaIni("[General]\nversion=1.2.3\n");
        var first = WritePlugin("First.esp", "FirstNpc");
        var second = WritePlugin("Second.esp", "SecondNpc");

        var result = await TrackTheMod();

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp 1.2.3", "Track Second.esp 1.2.3"], SubjectsOnMain());
        Assert.Equal(
            $"Plugin: First.esp\nUpstream-Version: 1.2.3\nMeta-SHA256: {metaSha256}\nBinary-SHA256: {first}\n",
            TrailersOf("main~1"));
        Assert.Equal(
            $"Plugin: Second.esp\nUpstream-Version: 1.2.3\nMeta-SHA256: {metaSha256}\nBinary-SHA256: {second}\n",
            TrailersOf("main"));
    }

    [Fact]
    public async Task Track_OfAModWithNoRecordedVersion_LeavesTheVersionOutOfEverySubjectAndTrailer()
    {
        var metaSha256 = WriteMetaIni("[General]\ngameName=Fallout4\n");
        var first = WritePlugin("First.esp", "FirstNpc");
        var second = WritePlugin("Second.esp", "SecondNpc");

        var result = await TrackTheMod();

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp", "Track Second.esp"], SubjectsOnMain());
        Assert.Equal($"Plugin: First.esp\nMeta-SHA256: {metaSha256}\nBinary-SHA256: {first}\n", TrailersOf("main~1"));
        Assert.Equal($"Plugin: Second.esp\nMeta-SHA256: {metaSha256}\nBinary-SHA256: {second}\n", TrailersOf("main"));
    }

    [Fact]
    public async Task Track_ReadsBackEachPluginsOwnTrailers_FromTheRepositoryTheyShare()
    {
        var metaSha256 = WriteMetaIni("[General]\nversion=1.2.3\n");
        var first = WritePlugin("First.esp", "FirstNpc");
        var second = WritePlugin("Second.esp", "SecondNpc");

        await TrackTheMod();

        Assert.Equal(
            new BaselineTrailers("First.esp", "1.2.3", metaSha256, first),
            SourceRepository.LatestBaselineTrailers(_modFolder, "First.esp"));
        Assert.Equal(
            new BaselineTrailers("Second.esp", "1.2.3", metaSha256, second),
            SourceRepository.LatestBaselineTrailers(_modFolder, "Second.esp"));
    }

    [Fact]
    public async Task Track_ParksEachPluginsLastCompileRef_AtItsOwnBaselineCommit()
    {
        WritePlugin("First.esp", "FirstNpc");
        WritePlugin("Second.esp", "SecondNpc");

        await TrackTheMod();

        Assert.Equal(Git("rev-parse", "main~1"), Git("rev-parse", SourceRepository.LastCompileRef("First.esp")));
        Assert.Equal(Git("rev-parse", "main"), Git("rev-parse", SourceRepository.LastCompileRef("Second.esp")));
        Assert.True(SourceRepository.MatchesParkedCompileBinary(_modFolder, "First.esp", File.ReadAllBytes(Path.Combine(_modFolder, "First.esp"))));
        Assert.True(SourceRepository.MatchesParkedCompileBinary(_modFolder, "Second.esp", File.ReadAllBytes(Path.Combine(_modFolder, "Second.esp"))));
    }

    private string WriteMetaIni(string text)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(text);
        File.WriteAllBytes(Path.Combine(_modFolder, "meta.ini"), bytes);
        return Convert.ToHexString(SHA256.HashData(bytes));
    }

    // The binary's own SHA-256, computed here from the bytes on disk.
    private string WritePlugin(string name, string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        var path = Path.Combine(_modFolder, name);
        mod.WriteToBinary(path);
        return Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
    }

    private Task<TrackResult> TrackTheMod()
    {
        var copies = Directory.GetFiles(_modFolder, "*.esp")
            .Order(StringComparer.Ordinal)
            .Select((path, slot) => new LoadOrderEntry(Path.GetFileName(path), path, ModName, slot, Enabled: true, Winning: true))
            .ToList();
        var loadOrder = new LoadOrderSnapshot(_gameDir, _gameDir, GameRelease.Fallout4, SnapshotCopies.Of(copies));
        return new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackAsync(loadOrder, ModName, SourcePreset.Edits);
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    // git's own trailer parser, so a block git would not read as trailers does not pass.
    private string TrailersOf(string revision) =>
        Git("show", "-s", "--format=%(trailers:only,unfold)", revision).TrimEnd('\n') + "\n";
}
