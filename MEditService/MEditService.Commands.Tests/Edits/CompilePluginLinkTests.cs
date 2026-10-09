using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginLinkTests : IDisposable
{
    private const string HostName = "LinkHost.esp";
    private const string HostOrigin = "LinkHostMod";
    private const string TargetName = "LinkTarget.esp";
    private const string TargetOrigin = "LinkTargetMod";
    private const string HostNpcEditorId = "LinkHostNpc";
    private const string TargetKeywordEditorId = "LinkTargetKeyword";
    private const string Dangling = "ABCDEF:LinkTarget.esp";

    private readonly ScratchDirectory _instanceRoot = new("medit-compile-links-");
    private readonly ScratchDirectory _gameDirectory = new("medit-compile-links-game-");
    private readonly string _hostFolder;
    private readonly string _targetFolder;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginAddress _host = new(HostName, HostOrigin);
    private readonly PluginAddress _target = new(TargetName, TargetOrigin);
    private readonly FormKey _npc;
    private readonly FormKey _targetKeyword;

    public CompilePluginLinkTests()
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

        _loadOrder = SnapshotPlugins.Snapshot(
            _gameDirectory, _instanceRoot, GameRelease.Fallout4,
            [
                new LoadOrderEntry(TargetName, targetPath, TargetOrigin, Line: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(HostName, hostPath, HostOrigin, Line: 1, Enabled: true, Winning: true),
            ]);
        TrackEveryPluginOf.ModAsync(_loadOrder, TargetOrigin).GetAwaiter().GetResult();
        TrackEveryPluginOf.ModAsync(_loadOrder, HostOrigin).GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _instanceRoot.Dispose();
        _gameDirectory.Dispose();
    }

    private SourceRepository HostRepository() =>
        SourceRepository.Open(TestMod.Of(_host, _hostFolder), GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected {_hostFolder} to already be a tracked repository.");

    private void PointTheNpcAt(FormKey keyword) =>
        SourceEdits.Rewrite<Npc>(
            HostRepository(), _host, new RecordIdentity(_npc.ToString(), "npc_", HostNpcEditorId),
            GameRelease.Fallout4,
            npc => npc.Keywords = [new FormLink<IKeywordGetter>(keyword)]);

    private async Task<SelectionResult<PluginAddress, CompileRefusal, IReadOnlyList<CompileDiagnostic>>> CompileHost() =>
        await CompileServices.Over(_loadOrder).CompileAsync([_host]);

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

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        var diagnostic = Assert.Single(diagnostics, d => d.Message.Contains(Dangling, StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), diagnostic.FormKey);
        Assert.Equal($"Keywords: [0]: [{Dangling}] <Error: Could not be resolved>", diagnostic.Message);
        Assert.Equal([FormKey.Factory(Dangling)], KeywordsInTheBinary());
    }

    [Fact]
    public async Task Compile_WhenEveryLinkResolvesAgainstTheLoadOrdersFiles_ReportsNoLinkDiagnostic()
    {
        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        Assert.DoesNotContain(
            diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_ForALinkIntoATrackedPlugin_ReadsThatPluginsFile_NotItsWorkingTree()
    {
        TrackedTree.Remove(_targetFolder, _target, new RecordIdentity(_targetKeyword.ToString(), "kywd", TargetKeywordEditorId));

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        Assert.DoesNotContain(
            diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_WhenALoadOrderFileCannotBeRead_NamesTheFile_AndReportsItsLinksAsUnchecked()
    {
        File.WriteAllText(Path.Combine(_targetFolder, TargetName), "not a plugin at all");

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        var aboutTheFile = Assert.Single(
            diagnostics, d => d.Message.StartsWith(TargetName, StringComparison.Ordinal));
        Assert.Contains("could not be read", aboutTheFile.Message, StringComparison.Ordinal);
        var aboutTheLink = Assert.Single(
            diagnostics, d => d.Message.StartsWith("Keywords:", StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), aboutTheLink.FormKey);
        Assert.Contains($"{TargetName} could not be read", aboutTheLink.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Could not be resolved", aboutTheLink.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WhenTheLinkCheckItselfFails_StillSucceeds_AndSaysTheCheckDidNotRun()
    {
        var answer = await CompileServices.Over(_loadOrder, new FaultyLinkAdapter())
            .CompileAsync([_host]);

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        var diagnostic = Assert.Single(diagnostics);
        Assert.Contains("links could not be checked", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains(FaultyLinkAdapter.Fault, diagnostic.Message, StringComparison.Ordinal);
        Assert.Equal([_targetKeyword], KeywordsInTheBinary());
    }

    private sealed class FaultyLinkAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        internal const string Fault = "the link cache could not be built";

        public override LinkAnswers LinkTargets(
            LoadOrderSnapshot loadOrder,
            RegisteredPlugin compiled,
            IReadOnlyCollection<string> formKeys) =>
            throw new InvalidOperationException(Fault);
    }

    [Fact]
    public async Task Compile_ForALinkToARecordTheCompiledPluginItselfHolds_ReportsNothingAboutIt()
    {
        var ownKeyword = new Keyword(FormKey.Factory($"000801:{HostName}"), Fallout4Release.Fallout4)
        {
            EditorID = "HostOwnKeyword",
        };
        SourceEdits.Write(HostRepository(), _host, ownKeyword, "kywd", GameRelease.Fallout4);
        PointTheNpcAt(ownKeyword.FormKey);

        var answer = await CompileHost();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        Assert.DoesNotContain(
            diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }
}
