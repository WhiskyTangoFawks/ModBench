using System.Security.Cryptography;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.Source;

/// <summary>What <c>git log</c> on <c>main</c> shows after Track of a plugin or a selection, through
/// the Commands box over a fixture mod folder and real git (ADR-0007 invariants 2 and 6).</summary>
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
    public async Task Track_OfBothPluginsOfAMod_CommitsTheModsOwnFiles_ThenEachPluginOnItsOwn()
    {
        var metaSha256 = WriteMetaIni("[General]\nversion=1.2.3\n");
        var first = WritePlugin("First.esp", "FirstNpc");
        var second = WritePlugin("Second.esp", "SecondNpc");

        var result = await Track("First.esp", "Second.esp");

        Assert.Empty(result.Refused);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp 1.2.3", "Track Second.esp 1.2.3"], SubjectsOnMain());
        Assert.Equal(
            $"Plugin: First.esp\nUpstream-Version: 1.2.3\nMeta-SHA256: {metaSha256}\nBinary-SHA256: {first}\n",
            TrailersOf("main~1"));
        Assert.Equal(
            $"Plugin: Second.esp\nUpstream-Version: 1.2.3\nMeta-SHA256: {metaSha256}\nBinary-SHA256: {second}\n",
            TrailersOf("main"));
        Assert.Equal("edit", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(Git("rev-parse", "refs/heads/main"), Git("rev-parse", "refs/heads/edit"));
    }

    [Fact]
    public async Task Track_OfAModWithNoRecordedVersion_LeavesTheVersionOutOfEverySubjectAndTrailer()
    {
        var metaSha256 = WriteMetaIni("[General]\ngameName=Fallout4\n");
        var first = WritePlugin("First.esp", "FirstNpc");
        var second = WritePlugin("Second.esp", "SecondNpc");

        var result = await Track("First.esp", "Second.esp");

        Assert.Empty(result.Refused);
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

        await Track("First.esp", "Second.esp");

        Assert.Equal(
            [new BaselineTrailers("Second.esp", "1.2.3", metaSha256, second), new BaselineTrailers("First.esp", "1.2.3", metaSha256, first)],
            SourceRepository.LatestBaselineTrailersNewestFirst(_modFolder, ["First.esp", "Second.esp"]));
    }

    [Fact]
    public async Task Track_ParksEachPluginsLastCompileRef_AtItsOwnBaselineCommit()
    {
        WritePlugin("First.esp", "FirstNpc");
        WritePlugin("Second.esp", "SecondNpc");

        await Track("First.esp", "Second.esp");

        Assert.Equal(Git("rev-parse", "main~1"), Git("rev-parse", SourceRepository.LastCompileRef("First.esp")));
        Assert.Equal(Git("rev-parse", "main"), Git("rev-parse", SourceRepository.LastCompileRef("Second.esp")));
        Assert.True(SourceRepository.MatchesParkedCompileBinary(_modFolder, "First.esp", File.ReadAllBytes(Path.Combine(_modFolder, "First.esp"))));
        Assert.True(SourceRepository.MatchesParkedCompileBinary(_modFolder, "Second.esp", File.ReadAllBytes(Path.Combine(_modFolder, "Second.esp"))));
    }

    [Fact]
    public async Task Track_OfOnePluginInAModWithTwo_LeavesTheOtherUntracked()
    {
        WritePlugin("First.esp", "FirstNpc");
        WritePlugin("Second.esp", "SecondNpc");

        var result = await Track("First.esp");

        Assert.Equal([Key("First.esp")], result.Landed);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp"], SubjectsOnMain());
        Assert.Empty(SourceRepository.LatestBaselineTrailersNewestFirst(_modFolder, ["Second.esp"]));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, SourceRepository.RootFor("Second.esp"))));
        Assert.Null(SourceRepository.ParkedCompileBinarySha256(_modFolder, "Second.esp"));
    }

    [Fact]
    public async Task Track_OfAPluginIntoAModThatAlreadyHasARepository_AddsOneBaselineCommit()
    {
        WritePlugin("First.esp", "FirstNpc");
        WritePlugin("Second.esp", "SecondNpc");
        await Track("First.esp");
        var editBefore = Git("rev-parse", "refs/heads/edit");

        var result = await Track("Second.esp");

        Assert.Equal([Key("Second.esp")], result.Landed);
        Assert.Empty(result.Refused);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp", "Track Second.esp"], SubjectsOnMain());
        Assert.Equal(editBefore, Git("rev-parse", "refs/heads/edit"));
    }

    [Fact]
    public async Task Track_OfAPluginAlreadyTracked_RefusesIt_AndLandsTheRestOfTheSelection()
    {
        WritePlugin("First.esp", "FirstNpc");
        WritePlugin("Second.esp", "SecondNpc");
        await Track("First.esp");

        var result = await Track("First.esp", "Second.esp");

        Assert.Equal([Key("Second.esp")], result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((Key("First.esp"), TrackRefusal.AlreadyTracked), (refused.Plugin, refused.Refusal));
        Assert.Equal(["Track TwoPluginMod", "Track First.esp", "Track Second.esp"], SubjectsOnMain());
    }

    // decompile-plugin, The command, step 9: a failure after a plugin's commit landed does not
    // report that plugin refused. A lock another git holds on the edit branch makes its checkout
    // fail after every baseline is on main.
    [Fact]
    public async Task Track_WhoseEditBranchCheckoutFails_ReportsThePluginsWhoseBaselinesLandedAsLanded()
    {
        WritePlugin("First.esp", "FirstNpc");
        Git("init", "-q", "-b", "main");
        File.WriteAllText(Path.Combine(_modFolder, ".git", "refs", "heads", "edit.lock"), "");

        var result = await Track("First.esp");

        Assert.Equal([Key("First.esp")], result.Landed);
        Assert.Empty(result.Refused);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp"], SubjectsOnMain());
    }

    // ADR-0003: a repository with history but no main is someone else's, and Track writes nothing to it.
    [Fact]
    public async Task Track_IntoAModWhoseRepositoryHasHistoryButNoMain_RefusesThePlugin_AndChangesNothingOfTheRepository()
    {
        WritePlugin("First.esp", "FirstNpc");
        Git("init", "-q", "-b", "master");
        File.WriteAllText(Path.Combine(_modFolder, ".gitignore"), "theirs\n");
        Git("add", ".gitignore");
        Git("-c", "user.name=Them", "-c", "user.email=them@localhost", "commit", "-q", "-m", "Their own commit");
        var logBefore = Git("log", "--all", "--format=%H %s");
        var gitignoreBefore = File.ReadAllBytes(Path.Combine(_modFolder, ".gitignore"));
        var configBefore = File.ReadAllBytes(Path.Combine(_modFolder, ".git", "config"));

        var result = await Track("First.esp");

        Assert.Empty(result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((Key("First.esp"), TrackRefusal.AlreadyTracked), (refused.Plugin, refused.Refusal));
        Assert.Contains(_modFolder, refused.Message, StringComparison.Ordinal);
        Assert.Equal(logBefore, Git("log", "--all", "--format=%H %s"));
        Assert.Equal(gitignoreBefore, File.ReadAllBytes(Path.Combine(_modFolder, ".gitignore")));
        Assert.Equal(configBefore, File.ReadAllBytes(Path.Combine(_modFolder, ".git", "config")));
    }

    // decompile-plugin, Refusals: a question open on the mod refuses the repository destination.
    [Fact]
    public async Task Track_IntoAModWithAnUnansweredExternalChange_RefusesThePlugin_NamingTheQuestion()
    {
        WritePlugin("First.esp", "FirstNpc");
        WritePlugin("Second.esp", "SecondNpc");
        await Track("First.esp");
        WritePlugin("First.esp", "ChangedByAnotherTool");
        SourceRepository.RaiseExternalChangeQuestion(_modFolder, "First.esp changed outside Modbench.");

        var result = await Track("Second.esp");

        var refused = Assert.Single(result.Refused);
        Assert.Equal((Key("Second.esp"), TrackRefusal.ExternalChangeUnanswered), (refused.Plugin, refused.Refusal));
        Assert.Equal("First.esp changed outside Modbench.", refused.Message);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp"], SubjectsOnMain());
    }

    [Fact]
    public async Task Track_OfASelectionWhereOnePluginFailsItsRoundTripGate_CommitsTheOthers_AndRefusesItOnceWithItsReason()
    {
        WritePlugin("First.esp", "FirstNpc");
        WritePlugin("Second.esp", "SecondNpc");
        WritePlugin("Third.esp", "ThirdNpc");

        var result = await Track(new RoundTripFailsFor("Second.esp"), "First.esp", "Second.esp", "Third.esp");

        Assert.Equal([Key("First.esp"), Key("Third.esp")], result.Landed);
        var refused = Assert.Single(result.Refused);
        Assert.Equal((Key("Second.esp"), TrackRefusal.RoundTripFailed), (refused.Plugin, refused.Refusal));
        Assert.Contains("SecondNpc", refused.Message, StringComparison.Ordinal);
        Assert.Equal(["Track TwoPluginMod", "Track First.esp", "Track Third.esp"], SubjectsOnMain());
        Assert.False(Directory.Exists(Path.Combine(_modFolder, SourceRepository.RootFor("Second.esp"))));
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public async Task Track_OfASelectionWhereEveryPluginIsRefused_CreatesNoRepository()
    {
        WritePlugin("Second.esp", "SecondNpc");

        var result = await Track(new RoundTripFailsFor("Second.esp"), "Second.esp");

        Assert.Empty(result.Landed);
        Assert.Single(result.Refused);
        Assert.False(SourceRepository.IsTracked(_modFolder));
        Assert.False(File.Exists(Path.Combine(_modFolder, ".gitignore")));
    }

    // The real adapter for every plugin but one, whose recompiled tree comes back with its NPC's
    // EditorID changed: a codec defect no real codec has.
    private sealed class RoundTripFailsFor(string plugin) : ReadOnlyPluginAdapter
    {
        public override Task WriteFromTreeAsync(
            IReadOnlyList<TreeFile> files, string destinationPath, CancellationToken cancel = default) =>
            files.Any(file => file.RelativePath.StartsWith(SourceRepository.RootFor(plugin), StringComparison.Ordinal))
                ? new ForgedTreeWriteAdapter(plugin, DeserializeThenCorruptTheNpc).WriteFromTreeAsync(files, destinationPath, cancel)
                : TestAdapters.Mutagen().WriteFromTreeAsync(files, destinationPath, cancel);

        private static async Task<IMod> DeserializeThenCorruptTheNpc(string folder, CancellationToken cancel)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, cancel);
            deserialized.Npcs.First().EditorID += "Corrupted";
            return deserialized;
        }
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

    private static PluginCopyKey Key(string plugin) => new(plugin, ModName);

    private Task<TrackSelectionResult> Track(params string[] plugins) => Track(TestAdapters.Mutagen(), plugins);

    private Task<TrackSelectionResult> Track(IPluginAdapter adapter, params string[] plugins)
    {
        var copies = Directory.GetFiles(_modFolder, "*.esp")
            .Order(StringComparer.Ordinal)
            .Select((path, slot) => new LoadOrderEntry(Path.GetFileName(path), path, ModName, slot, Enabled: true, Winning: true))
            .ToList();
        var loadOrder = new LoadOrderSnapshot(_gameDir, _gameDir, GameRelease.Fallout4, SnapshotCopies.Of(copies));
        return new TrackService(NullLogger<TrackService>.Instance, adapter)
            .TrackAsync(loadOrder, [.. plugins.Select(Key)], SourcePreset.Edits);
    }

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    // git's own trailer parser, so a block git would not read as trailers does not pass.
    private string TrailersOf(string revision) =>
        Git("show", "-s", "--format=%(trailers:only,unfold)", revision).TrimEnd('\n') + "\n";
}
