using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Link validation is compile's, against the plugin files the game loads and the plugin
/// just compiled (ADR-0007 invariant 4): the binary is written either way and a broken link is a
/// diagnostic.</summary>
public sealed class PluginCompileServiceLinkTests : IDisposable
{
    private const string HostName = "LinkHost.esp";
    private const string HostOrigin = "LinkHostMod";
    private const string TargetName = "LinkTarget.esp";
    private const string TargetOrigin = "LinkTargetMod";
    private const string HostNpcEditorId = "LinkHostNpc";
    private const string TargetKeywordEditorId = "LinkTargetKeyword";
    private const string Dangling = "ABCDEF:LinkTarget.esp";

    private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-compile-links-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-compile-links-game-").FullName;
    private readonly string _hostFolder;
    private readonly string _targetFolder;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginCopyKey _host = new(HostName, HostOrigin);
    private readonly PluginCopyKey _target = new(TargetName, TargetOrigin);
    private readonly FormKey _npc;
    private readonly FormKey _targetKeyword;

    public PluginCompileServiceLinkTests()
    {
        _targetFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", TargetOrigin)).FullName;
        _hostFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", HostOrigin)).FullName;

        var targetPath = Path.Combine(_targetFolder, TargetName);
        var target = new Fallout4Mod(ModKey.FromFileName(TargetName), Fallout4Release.Fallout4);
        _targetKeyword = target.Keywords.AddNew(TargetKeywordEditorId).FormKey;
        target.WriteToBinary(targetPath);

        var hostPath = Path.Combine(_hostFolder, HostName);
        var host = new Fallout4Mod(ModKey.FromFileName(HostName), Fallout4Release.Fallout4);
        var npc = host.Npcs.AddNew(HostNpcEditorId);
        npc.Keywords = [new FormLink<IKeywordGetter>(_targetKeyword)];
        _npc = npc.FormKey;
        host.WriteToBinary(hostPath, new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
        {
            MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.Iterate,
        });

        _loadOrder = new LoadOrderSnapshot(
            _gameDirectory, _instanceRoot, GameRelease.Fallout4,
            SnapshotCopies.Of([
                new LoadOrderEntry(TargetName, targetPath, TargetOrigin, Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(HostName, hostPath, HostOrigin, Slot: 1, Enabled: true, Winning: true),
            ]));

        var trackService = new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance);
        trackService.TrackAsync(_loadOrder, TargetOrigin, SourcePreset.Edits).GetAwaiter().GetResult();
        trackService.TrackAsync(_loadOrder, HostOrigin, SourcePreset.Edits).GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        TryDelete(_instanceRoot);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    private static SourceRepository Repository(string modFolder) =>
        SourceRepository.Open(modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected {modFolder} to already be a tracked repository.");

    private void PointTheNpcAt(FormKey keyword) =>
        SourceEdits.Rewrite<Npc>(
            Repository(_hostFolder), _host, new RecordIdentity(_npc.ToString(), "npc_", HostNpcEditorId),
            GameRelease.Fallout4,
            npc => npc.Keywords = [new FormLink<IKeywordGetter>(keyword)]);

    private async Task<CompileResult> CompileHost() =>
        await CompileServices.Over(_loadOrder).CompileAsync(_host, new CompileSource.WorkingTree());

    private IReadOnlyList<FormKey> KeywordsInTheBinary()
    {
        using var loaded = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(HostName), Path.Combine(_hostFolder, HostName)), Fallout4Release.Fallout4);
        var keywords = loaded.Npcs.Single().Keywords
            ?? throw new InvalidOperationException("Expected the compiled NPC to carry a Keywords collection.");
        return [.. keywords.Select(k => k.FormKey)];
    }

    [Fact]
    public async Task Compile_OfAPluginHoldingADanglingLink_WritesThePlugin_AndNamesTheRecordAndMember()
    {
        PointTheNpcAt(FormKey.Factory(Dangling));

        var result = await CompileHost();

        Assert.True(result.Succeeded, result.RefusalReason);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Message.Contains(Dangling, StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), diagnostic.FormKey);
        Assert.Equal($"Keywords: [0]: [{Dangling}] <Error: Could not be resolved>", diagnostic.Message);
        Assert.Equal([FormKey.Factory(Dangling)], KeywordsInTheBinary());
    }

    [Fact]
    public async Task Compile_WhenEveryLinkResolvesAgainstTheLoadOrdersFiles_ReportsNoLinkDiagnostic()
    {
        var result = await CompileHost();

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.DoesNotContain(
            result.Diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    // The target is tracked, so it has a working tree to disagree with its file. The file is what
    // the game loads, and it is what answers the link.
    [Fact]
    public async Task Compile_ForALinkIntoATrackedPlugin_ReadsThatPluginsFile_NotItsWorkingTree()
    {
        File.Delete(SourceDocumentPath.Of(
            _targetFolder, TargetName, "kywd", _targetKeyword.ToString(), TargetKeywordEditorId, GameRelease.Fallout4));

        var result = await CompileHost();

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.DoesNotContain(
            result.Diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    // ADR-0019: a file that could not be read is a fact the author is told, not one the records are
    // blamed for. Both halves: the file is named, and the link into it says why it is unchecked.
    [Fact]
    public async Task Compile_WhenALoadOrderFileCannotBeRead_NamesTheFile_AndReportsItsLinksAsUnchecked()
    {
        File.WriteAllText(Path.Combine(_targetFolder, TargetName), "not a plugin at all");

        var result = await CompileHost();

        Assert.True(result.Succeeded, result.RefusalReason);
        var aboutTheFile = Assert.Single(
            result.Diagnostics, d => d.Message.StartsWith(TargetName, StringComparison.Ordinal));
        Assert.Contains("could not be read", aboutTheFile.Message, StringComparison.Ordinal);
        var aboutTheLink = Assert.Single(
            result.Diagnostics, d => d.Message.StartsWith("Keywords:", StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), aboutTheLink.FormKey);
        Assert.Contains($"{TargetName} could not be read", aboutTheLink.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Could not be resolved", aboutTheLink.Message, StringComparison.Ordinal);
    }

    // The plugin is written and parked before the links are read, so a fault in the check is the
    // report's failure, never the compile's.
    [Fact]
    public async Task Compile_WhenTheLinkCheckItselfFails_StillSucceeds_AndSaysTheCheckDidNotRun()
    {
        var result = await CompileServices.Over(_loadOrder, new FaultyLinkAdapter())
            .CompileAsync(_host, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        var diagnostic = Assert.Single(result.Diagnostics);
        Assert.Contains("links could not be checked", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains(FaultyLinkAdapter.Fault, diagnostic.Message, StringComparison.Ordinal);
        Assert.Equal([_targetKeyword], KeywordsInTheBinary());
    }

    private sealed class FaultyLinkAdapter : ReadOnlyPluginAdapter
    {
        internal const string Fault = "the link cache could not be built";

        public override LinkAnswers LinkTargets(
            IReadOnlyList<ModPath> loadOrder,
            GameRelease gameRelease,
            IReadOnlyDictionary<string, RecordTableSchema> schemas,
            IReadOnlyCollection<string> formKeys) =>
            throw new InvalidOperationException(Fault);
    }

    // A record this compile's own source holds resolves through the file this compile just wrote,
    // which is why the write comes first.
    [Fact]
    public async Task Compile_ForALinkToARecordTheCompiledPluginItselfHolds_ReportsNothingAboutIt()
    {
        var ownKeyword = new Keyword(FormKey.Factory($"000801:{HostName}"), Fallout4Release.Fallout4)
        {
            EditorID = "HostOwnKeyword",
        };
        SourceEdits.Write(Repository(_hostFolder), _host, ownKeyword, "kywd", GameRelease.Fallout4);
        PointTheNpcAt(ownKeyword.FormKey);

        var result = await CompileHost();

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.DoesNotContain(
            result.Diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }
}
